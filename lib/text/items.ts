"use client";

import UPNG from "upng-js";
import type { MovieFile } from "../svga";
import type { Transform } from "../movie";
import { MIN_ALPHA, resolveImageKey, spritesOf } from "../renderer";
import { buildGlyphLibrary, textFromName, type GlyphLibrary, type GlyphSample } from "../glyphs";
import { findTextLines, type TextLine } from "./detect";
import { alphaMask, clearMask, dilateMask, expandMask, inpaint, maskCount, maskPalette, orMask, paletteMatch, refineFootprint, textFootprint, type Mask } from "./inpaint";
import { readMask } from "./ocr";
import { matchFont } from "./fontmatch";
import {
  alphaBounds, canvasToRaster, clampRect, cloneRaster, coverage, get2dCtx, inkShare, iou, makeCanvas, padRect, rasterOfBytes, rasterToCanvas, rasterToPng,
  type Raster, type Rect,
} from "./raster";
import { companionStyle, DEFAULT_STYLE, drawText, measureLettering, styleFromMeasured, type Anchor, type Measured, type TextStyle } from "./style";

/**
 * Text in an SVGA, as a list of items the user can edit one by one.
 *
 * An item is one run of text and every bitmap that carries it:
 *
 *   slot     - an empty (transparent) bitmap the app fills at runtime with
 *              a name or a level; typing here bakes text into it.
 *   layer    - letters on their own transparent layer ("VIP 5" in gold),
 *              often stacked with a shadow and a highlight copy — each copy
 *              is a layer of the item, redrawn in its own colour.
 *   painted  - letters painted into artwork (a ribbon, a plate), possibly
 *              in every frame of an image sequence. Only the letter pixels
 *              are erased and refilled; then the new text is drawn.
 *   hidden   - a text bitmap that never shows (1% opacity, off canvas):
 *              typically a seller's watermark.
 *
 * Items come from analysis (slots, detection, sibling diffs) or from the
 * user drawing a box over text on the stage.
 */

export type Point = { x: number; y: number };

export type ItemLayer = {
  /** The bitmap this layer was found in. */
  key: string;
  /** Every bitmap the layer applies to: the frames of a sequence, or just `key`. */
  keys: string[];
  /** Where the letters are, in `key`'s pixels — the area erased and drawn in. */
  region: Rect;
  role: "main" | "companion";
  /** clear: the layer is only text (make it transparent); inpaint: text on art; none: an empty slot. */
  erase: "clear" | "inpaint" | "none";
  /** The glyph pixels found by the detector (raster coordinates), when known. */
  fill: Mask | null;
  glyphs: Rect[];
  /** Bitmap → canvas at the item's frame. */
  transform: Transform;
  /** A companion's own flat colour (shadow, highlight). */
  color?: string;
};

export type ItemKind = "slot" | "image-slot" | "layer" | "painted" | "hidden";

export type TextItem = {
  id: string;
  kind: ItemKind;
  source: "slot" | "detected" | "diff" | "manual";
  layers: ItemLayer[];
  /** A frame on which the main layer is visible. */
  frame: number;
  /** Where the text shows, in viewBox coordinates at `frame`. */
  canvasBox: Rect;
  score: number;
  confident: boolean;
  /** The text as read by OCR (or known from the file name); "" when unread. */
  original: string;
  /** OCR read real text here. */
  verified: boolean;
  /** How the original lettering looks (main layer), when measured. */
  measured: Measured | null;
  /** Baseline and centre of the text, as fractions of the main region (null: centred, for slots). */
  anchor: { baseline: number; cx: number } | null;

  /* ---- the edit ---- */
  /** New text. Empty: leave the item alone (unless `remove`). */
  text: string;
  /** Erase the text and write nothing. */
  remove: boolean;
  style: TextStyle;
  /** The style that matches the original, to reset to. */
  matched: TextStyle;
  /** Nudge in main-bitmap pixels. */
  offset: Point;
  /** "set": compose from the set's own glyphs (sibling files); "font": draw with a font. */
  lettering: "set" | "font";
};

export type SiblingFile = { name: string; movie: MovieFile };

export type TextAnalysis = {
  items: TextItem[];
  /** The set's own digits, when numbered siblings are loaded. */
  glyphs: GlyphLibrary | null;
  glyphsNote: string;
  siblingsUsed: number;
  ms: number;
};

/* ------------------------------------------------------------------ */
/* Where each bitmap is drawn                                             */
/* ------------------------------------------------------------------ */

export type ImageUse = {
  key: string;
  /** Frames on which some sprite draws it visibly. */
  frames: number[];
  /** The frame where it is most opaque (middle of the run on ties) and its transform there. */
  bestFrame: number;
  transform: Transform;
  alphaMax: number;
  /** Bitmap bounds on the canvas at `bestFrame`. */
  canvasBox: Rect | null;
  onCanvas: boolean;
  sprites: number[];
};

const useCache = new WeakMap<MovieFile, Map<string, ImageUse>>();

export function imageUses(movie: MovieFile, sizes: Map<string, { width: number; height: number }>): Map<string, ImageUse> {
  const cached = useCache.get(movie);
  if (cached && [...sizes.keys()].every((k) => !cached.has(k) || cached.get(k)!.canvasBox)) return cached;
  const out = new Map<string, ImageUse>();
  const W = movie.params.viewBoxWidth, H = movie.params.viewBoxHeight;
  spritesOf(movie).forEach((s, si) => {
    const key = resolveImageKey(movie, s.imageKey);
    if (!key) return;
    let u = out.get(key);
    if (!u) out.set(key, (u = { key, frames: [], bestFrame: -1, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, alphaMax: 0, canvasBox: null, onCanvas: false, sprites: [] }));
    u.sprites.push(si);
    const vis: number[] = [];
    s.frames.forEach((f, i) => { if (f.alpha > MIN_ALPHA) vis.push(i); });
    for (const i of vis) {
      u.frames.push(i);
      const f = s.frames[i];
      const mid = vis[Math.floor(vis.length / 2)];
      if (f.alpha > u.alphaMax + 0.02 || (Math.abs(f.alpha - u.alphaMax) <= 0.02 && i === mid)) { u.alphaMax = Math.max(u.alphaMax, f.alpha); u.bestFrame = i; u.transform = f.transform; }
    }
  });
  for (const u of out.values()) {
    u.frames = [...new Set(u.frames)].sort((a, b) => a - b);
    const size = sizes.get(u.key);
    if (size && u.bestFrame >= 0) {
      u.canvasBox = mapRect(u.transform, { x: 0, y: 0, width: size.width, height: size.height });
      const b = u.canvasBox;
      u.onCanvas = b.x < W && b.y < H && b.x + b.width > 0 && b.y + b.height > 0;
    }
  }
  useCache.set(movie, out);
  return out;
}

export function apply(t: Transform, p: Point): Point {
  return { x: t.a * p.x + t.c * p.y + t.tx, y: t.b * p.x + t.d * p.y + t.ty };
}

export function invert(t: Transform): Transform | null {
  const det = t.a * t.d - t.b * t.c;
  if (Math.abs(det) < 1e-9) return null;
  return { a: t.d / det, b: -t.b / det, c: -t.c / det, d: t.a / det, tx: (t.c * t.ty - t.d * t.tx) / det, ty: (t.b * t.tx - t.a * t.ty) / det };
}

export function mapRect(t: Transform, r: Rect): Rect {
  const pts = [apply(t, { x: r.x, y: r.y }), apply(t, { x: r.x + r.width, y: r.y }), apply(t, { x: r.x, y: r.y + r.height }), apply(t, { x: r.x + r.width, y: r.y + r.height })];
  const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y));
  return { x: x0, y: y0, width: Math.max(...pts.map((p) => p.x)) - x0, height: Math.max(...pts.map((p) => p.y)) - y0 };
}

export const scaleOf = (t: Transform) => Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1;

/**
 * Frame sequences: three or more same-size bitmaps, each shown on only a
 * few frames. Text baked into one frame is baked into all; ordered by when
 * they play.
 */
function sequences(uses: Map<string, ImageUse>, sizes: Map<string, { width: number; height: number }>, total: number): Map<string, string[]> {
  const bySize = new Map<string, ImageUse[]>();
  for (const u of uses.values()) {
    const s = sizes.get(u.key);
    if (!s || !u.frames.length || u.frames.length > Math.max(2, total * 0.25)) continue;
    const k = `${s.width}x${s.height}`;
    (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(u);
  }
  const out = new Map<string, string[]>();
  for (const g of bySize.values()) {
    if (g.length < 3) continue;
    const keys = g.sort((a, b) => a.frames[0] - b.frames[0]).map((u) => u.key);
    for (const k of keys) out.set(k, keys);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Analysis                                                                */
/* ------------------------------------------------------------------ */

const TEXT_SLOT = /(^|[^a-z])(name|nick|nickname|text|txt|title|label|num|number|level|lv|lvl|user|uname|id|word|msg|count|rank|tag|vip|wenzi|zi|mingzi|nicheng)\d*([^a-z]|$)/i;
const IMAGE_SLOT = /(avatar|avator|head|touxiang|icon|photo|pic|portrait|face|gift|liwu|image|img_?user|user_?img|cover|logo)/i;

/** Pad a detected line box to take the outline and glow along. */
function padLine(box: Rect, h: number, w: number, hgt: number): Rect {
  return clampRect(padRect(box, Math.round(h * 0.3) + 1, Math.round(h * 0.22) + 1), w, hgt);
}

function lineMask(l: TextLine): Mask {
  const b = l.box;
  const out = new Uint8Array(b.width * b.height);
  const m = l.mask;
  if (m) {
    for (let y = 0; y < b.height; y++) {
      const sy = Math.min(m.height - 1, Math.floor((y / b.height) * m.height));
      for (let x = 0; x < b.width; x++) {
        const sx = Math.min(m.width - 1, Math.floor((x / b.width) * m.width));
        out[y * b.width + x] = m.data[sy * m.width + sx];
      }
    }
  }
  return { data: out, width: b.width, height: b.height, x: b.x, y: b.y };
}

/**
 * Pull in letters the detector missed beside a line — a capital that ran
 * into the ribbon edge at that threshold, a glyph under a sparkle. Pixels
 * in the line's own colours are grouped; blobs of letter size standing in
 * the line's band, close to it, are added, repeatedly.
 */
export function growLine(r: Raster, line: TextLine): TextLine {
  if (line.polarity === "alpha") return line;
  const fill = lineMask(line);
  const palette = maskPalette(r, fill, 0.03);
  if (!palette.length) return line;
  const h = Math.max(4, line.height);
  // Capitals stand taller than the lowercase that sets the median height.
  const tall = Math.max(h, ...line.glyphs.map((g) => g.height));
  const bx0 = Math.max(0, Math.floor(line.box.x - h * 6)), bx1 = Math.min(r.width, Math.ceil(line.box.x + line.box.width + h * 6));
  const by0 = Math.max(0, Math.floor(line.box.y - tall * 0.35)), by1 = Math.min(r.height, Math.ceil(line.box.y + line.box.height + h * 0.3));
  const W = bx1 - bx0, H = by1 - by0;
  if (W <= 0 || H <= 0) return line;
  const on = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = ((y + by0) * r.width + x + bx0) * 4;
    if (r.data[o + 3] < 160) continue;
    if (palette.some((c) => Math.abs(r.data[o] - c[0]) + Math.abs(r.data[o + 1] - c[1]) + Math.abs(r.data[o + 2] - c[2]) <= 75)) on[y * W + x] = 1;
  }
  type B = { x0: number; y0: number; x1: number; y1: number; area: number; px: number[] };
  const seen = new Uint8Array(W * H);
  const blobs: B[] = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (!on[s] || seen[s]) continue;
    seen[s] = 1; stack.push(s);
    const b: B = { x0: W, y0: H, x1: -1, y1: -1, area: 0, px: [] };
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W, y = (i - x) / W;
      b.area++; b.px.push(i);
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < W * H && on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    blobs.push(b);
  }
  let x0 = line.box.x, x1 = line.box.x + line.box.width;
  const mid = line.box.y + line.box.height / 2 - by0;
  // The line's own backing (ribbon, plate): opaque pixels in its box that aren't letters.
  const backing: number[][] = (() => {
    const inv: Mask = { data: new Uint8Array(fill.width * fill.height), width: fill.width, height: fill.height, x: fill.x, y: fill.y };
    for (let i = 0; i < inv.data.length; i++) inv.data[i] = fill.data[i] ? 0 : 1;
    return maskPalette(r, inv, 0.05);
  })();
  const near = (o: number, pal: number[][], tol: number) => pal.some((c) => Math.abs(r.data[o] - c[0]) + Math.abs(r.data[o + 1] - c[1]) + Math.abs(r.data[o + 2] - c[2]) <= tol);
  /** Only backing (or letters) between the line and the blob — no border to cross. */
  const sameBacking = (from: number, to: number) => {
    if (!backing.length) return true;
    const y = Math.round(line.box.y + line.box.height * 0.5);
    let odd = 0;
    for (let x = Math.min(from, to); x < Math.max(from, to); x++) {
      const o = (y * r.width + x) * 4;
      if (r.data[o + 3] < 128 || (!near(o, backing, 110) && !near(o, palette, 90))) odd++;
    }
    return odd <= Math.max(1, Math.abs(to - from) * 0.25);
  };
  const added: B[] = [];
  const used = new Set<B>();
  const perSide: Record<string, number> = {};
  for (let changed = true; changed;) {
    changed = false;
    for (const b of blobs) {
      if (used.has(b)) continue;
      const bh = b.y1 - b.y0 + 1, bw = b.x1 - b.x0 + 1;
      if (b.area < h * 0.6 || bh < h * 0.55 || bh > tall * 1.3 || bw > tall * 1.6) continue;
      // The letters' own colour, closely: a gilt border near cream lettering is not a letter.
      let cr = 0, cg = 0, cb = 0;
      for (const i of b.px) { const o = ((Math.floor(i / W) + by0) * r.width + (i % W) + bx0) * 4; cr += r.data[o]; cg += r.data[o + 1]; cb += r.data[o + 2]; }
      const n0 = b.px.length, main = palette[0];
      if (Math.abs(cr / n0 - main[0]) + Math.abs(cg / n0 - main[1]) + Math.abs(cb / n0 - main[2]) > 55) continue;
      if (b.area / (bw * bh) > 0.88) continue;
      if (Math.abs(b.y1 + by0 - (line.box.y + line.box.height)) > h * 0.35 && Math.abs((b.y0 + b.y1) / 2 - mid) > h * 0.4) continue;
      const gx0 = b.x0 + bx0, gx1 = b.x1 + bx0 + 1;
      // Already inside the line: nothing to add.
      if (gx0 >= x0 && gx1 <= x1) { used.add(b); continue; }
      const gap = Math.max(gx0 - x1, x0 - gx1);
      if (gap > h * 0.9) continue;
      // A letter's strokes are as thick as the line's; streaks and sparkles are not.
      const thick = (2 * b.area) / (bw + bh);
      if (line.strokeWidth > 0 && (thick < line.strokeWidth * 0.45 || thick > line.strokeWidth * 2.4)) continue;
      const side = gx0 < x0 ? "l" : "r";
      if (!(side === "l" ? sameBacking(gx1, x0) : sameBacking(x1, gx0))) continue;
      if ((perSide[side] = (perSide[side] ?? 0) + 1) > 3) continue;
      used.add(b); added.push(b); changed = true;
      x0 = Math.min(x0, gx0); x1 = Math.max(x1, gx1);
    }
  }
  if (!added.length) return line;
  const box = { x: x0, y: line.box.y, width: x1 - x0, height: line.box.height };
  const data = new Uint8Array(box.width * box.height);
  for (let y = 0; y < fill.height; y++) for (let x = 0; x < fill.width; x++) if (fill.data[y * fill.width + x]) data[(y + fill.y - box.y) * box.width + x + fill.x - box.x] = 1;
  const glyphs = [...line.glyphs];
  for (const b of added) {
    for (const i of b.px) {
      const x = (i % W) + bx0 - box.x, y = Math.floor(i / W) + by0 - box.y;
      if (x >= 0 && y >= 0 && x < box.width && y < box.height) data[y * box.width + x] = 1;
    }
    glyphs.push({ x: b.x0 + bx0, y: b.y0 + by0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1 });
  }
  return { ...line, box, glyphs, mask: { data, width: box.width, height: box.height }, maskScale: 1 };
}

/**
 * Letters on their own layer: the line is (nearly) all of the layer's ink,
 * and between the letters there is transparency, not artwork.
 */
function ownLayer(r: Raster, line: TextLine): boolean {
  const ink = alphaBounds(r, 16);
  if (!ink) return false;
  // Nothing of the bitmap lies away from the text…
  if (coverage(ink, padRect(line.box, line.height * 0.8, line.height * 0.6)) < 0.9) return false;
  // …and what surrounds the letters is their own glow, outline or shadow
  // (it fades with distance), not a plate (opaque all the way across).
  const letters = lineMask(line);
  const near = dilateMask(letters, Math.max(2, Math.round(line.height * 0.3)));
  let far = 0, farOpaque = 0;
  for (let y = ink.y; y < ink.y + ink.height; y++) for (let x = ink.x; x < ink.x + ink.width; x++) {
    const nx = x - near.x, ny = y - near.y;
    if (nx >= 0 && ny >= 0 && nx < near.width && ny < near.height && near.data[ny * near.width + nx]) continue;
    far++;
    if (r.data[(y * r.width + x) * 4 + 3] > 128) farOpaque++;
  }
  return !far || farOpaque / far < 0.35;
}

let idSeq = 0;
const newId = (key: string, r: Rect) => `${key}@${Math.round(r.x)},${Math.round(r.y)}#${++idSeq}`;

type Candidate = { key: string; line: TextLine; region: Rect; erase: "clear" | "inpaint"; score: number; keys: string[]; use: ImageUse; consistent: boolean };

/**
 * Find every item in a movie. Detection runs per bitmap — static bitmaps and
 * one frame of each sequence — so no effect drawn over the text gets in the
 * way and no frame has to be guessed.
 */
export async function analyzeText(movie: MovieFile, siblings: SiblingFile[] = [], activeName = ""): Promise<TextAnalysis> {
  const t0 = performance.now();
  const keys = Object.keys(movie.images);
  const rasters = new Map<string, Raster>();
  for (const k of keys) { const r = await rasterOfBytes(movie.images[k]); if (r) rasters.set(k, r); }
  const sizes = new Map([...rasters].map(([k, r]) => [k, { width: r.width, height: r.height }]));
  const uses = imageUses(movie, sizes);
  const total = Math.max(1, movie.params.frames);
  const seq = sequences(uses, sizes, total);
  const items: TextItem[] = [];

  // 1. Slots: empty bitmaps the app writes into.
  for (const [k, r] of rasters) {
    const u = uses.get(k);
    if (!u || !u.frames.length || r.width < 4 || r.height < 4) continue;
    if (inkShare(r, 6) > 0.002) continue;
    // Exporters leave empty bitmaps for null layers too: only a name that says
    // so, or a wide strip that stays on screen, makes one a slot.
    const named = TEXT_SLOT.test(k);
    const imageLike = IMAGE_SLOT.test(k) && !named;
    const persistent = u.frames.length >= total * 0.5;
    const textLike = named || (!imageLike && persistent && r.width >= r.height * 2.5 && r.height >= 12);
    if (!textLike && !imageLike) continue;
    const region = { x: 0, y: 0, width: r.width, height: r.height };
    const style: TextStyle = { ...DEFAULT_STYLE, capHeight: Math.max(4, Math.min(r.height * 0.55, r.width / 3)), fill: { mode: "solid", colors: ["#ffffff"] }, stroke: { ...DEFAULT_STYLE.stroke, enabled: false } };
    items.push(baseItem({
      kind: textLike ? "slot" : "image-slot", source: "slot", frame: u.bestFrame, score: textLike ? 400 : 120, confident: true,
      layers: [{ key: k, keys: [k], region, role: "main", erase: "none", fill: null, glyphs: [], transform: u.transform }],
      canvasBox: mapRect(u.transform, region), style,
    }));
  }

  // 2. Detection, per bitmap.
  const cands: Candidate[] = [];
  const done = new Set<string>();
  for (const [k, r] of rasters) {
    const u = uses.get(k);
    // Never drawn (alpha 0 on every frame): nobody sees it, nothing to edit.
    if (!u || !u.frames.length || r.width < 8 || r.height < 8) continue;
    if (inkShare(r, 6) <= 0.002) continue;
    const group = seq.get(k);
    if (group) {
      if (done.has(group[0])) continue;
      done.add(group[0]);
    }
    const rep = group ? group[Math.floor(group.length / 2)] : k;
    const rr = rasters.get(rep)!;
    const ru = uses.get(rep)!;
    const lines = findTextLines(rr).filter((l) => l.score >= 20).map((l) => growLine(rr, l));
    if (!lines.length) continue;
    for (const line of lines.slice(0, 4)) {
      const region = padLine(line.box, line.height, rr.width, rr.height);
      const own = ownLayer(rr, line);
      let score = line.score * (own ? 1.6 : 1) * (line.confident ? 1.3 : 1);
      // Text in a sequence stays put from frame to frame; an effect doesn't.
      let consistent = false;
      if (group && group.length >= 3) {
        const probes = [group[Math.floor(group.length * 0.2)], group[Math.floor(group.length * 0.8)]].filter((p) => p !== rep);
        let hits = 0;
        for (const p of probes) {
          const pr = rasters.get(p);
          if (!pr) continue;
          const found = findTextLines(pr, { within: padRect(line.box, line.height, line.height * 0.6), lenient: true });
          if (found.some((f) => iou(f.box, line.box) >= 0.45)) hits++;
        }
        consistent = hits === probes.length && probes.length > 0;
        score *= consistent ? 1.5 : 0.5;
      }
      // Lettering too small to read on the canvas isn't worth offering first.
      const canvasH = line.height * scaleOf(ru.transform);
      if (canvasH < 5) score *= 0.3;
      cands.push({ key: rep, line, region, erase: own ? "clear" : "inpaint", score, keys: group ?? [rep], use: ru, consistent });
    }
  }

  // 3. Group candidates that draw at the same place (a text layer and its shadow/highlight copies).
  cands.sort((a, b) => b.score - a.score);
  const used = new Set<Candidate>();
  for (const c of cands) {
    if (used.has(c)) continue;
    used.add(c);
    const canvasBox = mapRect(c.use.transform, c.line.box);
    const layers: ItemLayer[] = [{ key: c.key, keys: c.keys, region: c.region, role: "main", erase: c.erase, fill: lineMask(c.line), glyphs: c.line.glyphs, transform: c.use.transform }];
    for (const o of cands) {
      if (used.has(o) || o.key === c.key) continue;
      const ob = mapRect(o.use.transform, o.line.box);
      if (iou(ob, canvasBox) < 0.5) continue;
      if (Math.abs(ob.height - canvasBox.height) > canvasBox.height * 0.35) continue;
      used.add(o);
      layers.push({ key: o.key, keys: o.keys, region: o.region, role: "companion", erase: o.erase, fill: lineMask(o.line), glyphs: o.line.glyphs, transform: o.use.transform, color: `#${o.line.color.map((v) => v.toString(16).padStart(2, "0")).join("")}` });
    }
    const hidden = c.use.alphaMax < 0.05 || !c.use.onCanvas;
    items.push(baseItem({
      kind: hidden ? "hidden" : c.erase === "clear" ? "layer" : "painted",
      source: "detected",
      frame: c.use.bestFrame,
      layers,
      canvasBox,
      score: Math.round(c.score),
      // Until OCR has read it, only strong, clean lettering counts as found.
      confident: c.line.confident && c.score >= 150 && (c.erase === "clear" || c.consistent || c.keys.length === 1),
    }));
  }

  // A hidden layer is one thing to delete, however many lines it holds.
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.kind !== "hidden") continue;
    for (let j = items.length - 1; j > i; j--) {
      const b = items[j];
      if (b.kind !== "hidden" || b.layers[0].key !== a.layers[0].key) continue;
      a.score = Math.max(a.score, b.score);
      a.confident = a.confident || b.confident;
      a.layers[0] = { ...a.layers[0], region: unionRegion(a.layers[0].region, b.layers[0].region) };
      a.canvasBox = unionRegion(a.canvasBox, b.canvasBox);
      items.splice(j, 1);
    }
  }

  // 4. Siblings: bitmaps that differ between files of one set carry the text.
  let glyphs: GlyphLibrary | null = null;
  let glyphsNote = "";
  let siblingsUsed = 0;
  if (siblings.length) {
    const diff = await siblingDiff(movie, siblings, rasters, uses);
    siblingsUsed = diff.used;
    // A text painted into a sequence differs in every frame: one item for the whole sequence.
    const grouped = new Map<string, Rect>();
    for (const [k, region] of diff.regions) {
      const g = seq.get(k);
      const rep = g ? g[Math.floor(g.length / 2)] : k;
      grouped.set(rep, grouped.has(rep) ? unionRegion(grouped.get(rep)!, region) : region);
    }
    for (const [k, region] of grouped) {
      const u = uses.get(k);
      const r = rasters.get(k);
      if (!u || !r) continue;
      const lines = findTextLines(r, { within: padRect(region, 4), lenient: true });
      const line = lines.find((l) => iou(l.box, region) > 0.2) ?? null;
      const canvasBox = mapRect(u.transform, region);
      // A diff beats a detection of the same text.
      for (let i = items.length - 1; i >= 0; i--) if (items[i].source === "detected" && iou(items[i].canvasBox, canvasBox) > 0.3) items.splice(i, 1);
      items.push(baseItem({
        kind: "painted", source: "diff", frame: u.bestFrame, score: 1000, confident: true, canvasBox,
        layers: [{ key: k, keys: seq.get(k) ?? [k], region: padRect(region, 1), role: "main", erase: "inpaint", fill: line ? lineMask(line) : null, glyphs: line?.glyphs ?? [], transform: u.transform }],
      }));
    }
    // The set's own digits, when the names carry the numbers.
    if (grouped.size === 1 && diff.regions.size === 1 && diff.names.length) {
      const [key, region] = [...grouped][0];
      const named = [{ name: activeName, movie }, ...siblings.filter((s) => diff.names.includes(s.name))].map((f) => ({ text: textFromName(f.name), movie: f.movie }));
      const usable = named.filter((f): f is { text: string; movie: MovieFile } => !!f.text);
      if (!textFromName(activeName)) glyphsNote = "The file name carries no number, so the set's own digits can't be matched to it.";
      else if (usable.length < 2) glyphsNote = "The sibling names carry no numbers, so their digits can't be told apart.";
      else {
        try {
          const samples: GlyphSample[] = [];
          for (const f of usable) { const r = await rasterOfBytes(f.movie.images[key]); if (r) samples.push({ text: f.text, raster: r }); }
          glyphs = buildGlyphLibrary(key, samples, region);
          glyphsNote = `digits ${glyphs.chars.split("").join(" ")} lifted from ${samples.length} files`;
          const it = items.find((i) => i.source === "diff" && i.layers[0].key === key);
          if (it) { it.lettering = "set"; it.original = textFromName(activeName) ?? ""; }
        } catch (e) {
          glyphsNote = `couldn't lift the set's glyphs: ${(e as Error).message}`;
        }
      }
    }
  }

  // 5. Measure the look of the strongest items so new text matches from the start.
  items.sort((a, b) => b.score - a.score);
  for (const it of items.slice(0, 16)) {
    if (it.kind === "slot" || it.kind === "image-slot") continue;
    await measureItem(movie, it, rasters);
  }
  return { items, glyphs, glyphsNote, siblingsUsed, ms: Math.round(performance.now() - t0) };
}

function baseItem(p: Pick<TextItem, "kind" | "source" | "layers" | "frame" | "canvasBox" | "score" | "confident"> & { style?: TextStyle }): TextItem {
  const style = p.style ?? DEFAULT_STYLE;
  return {
    id: newId(p.layers[0].key, p.layers[0].region),
    kind: p.kind, source: p.source, layers: p.layers, frame: Math.max(0, p.frame), canvasBox: p.canvasBox,
    score: p.score, confident: p.confident, original: "", verified: false, measured: null, anchor: null,
    text: "", remove: false, style, matched: style, offset: { x: 0, y: 0 }, lettering: "font",
  };
}

/** Measure the main layer's lettering and set the item's matched style. */
export async function measureItem(movie: MovieFile, it: TextItem, rasters?: Map<string, Raster>) {
  const main = it.layers[0];
  const r = rasters?.get(main.key) ?? (await rasterOfBytes(movie.images[main.key]));
  if (!r) return;
  let fill = main.fill;
  let glyphs = main.glyphs;
  if (!fill || !maskCount(fill)) {
    const lines = findTextLines(r, { within: main.region, lenient: true });
    const best = lines.sort((a, b) => b.score - a.score)[0];
    if (best) { fill = lineMask(best); glyphs = best.glyphs; main.fill = fill; main.glyphs = glyphs; }
  }
  const foot = main.erase === "clear" ? alphaMask(r, main.region, 24) : textFootprint(r, main.region, { hint: fill, grow: 0 });
  const m = measureLettering(r, fill ?? { data: new Uint8Array(0), width: 0, height: 0, x: 0, y: 0 }, foot, glyphs, main.region);
  it.measured = m;
  const reg = main.region;
  it.anchor = { baseline: (m.anchor.baseline - reg.y) / Math.max(1, reg.height), cx: (m.anchor.cx - reg.x) / Math.max(1, reg.width) };
  it.matched = { ...styleFromMeasured(m, it.style), font: it.style.font };
  it.style = it.matched;
  for (const c of it.layers.slice(1)) {
    const cr = rasters?.get(c.key) ?? (await rasterOfBytes(movie.images[c.key]));
    if (!cr || !c.fill) continue;
    const cm = measureLettering(cr, c.fill, null, c.glyphs, c.region);
    c.color = cm.fill[Math.floor(cm.fill.length / 2)] ?? cm.color;
  }
}

/* ------------------------------------------------------------------ */
/* OCR                                                                     */
/* ------------------------------------------------------------------ */

/** Read the text of each detected item (best first); `onRead` fires per item. */
export async function readItems(items: TextItem[], onRead: (it: TextItem) => void, limit = 8): Promise<void> {
  for (const it of items.filter((i) => (i.kind === "layer" || i.kind === "painted" || i.kind === "hidden") && i.layers[0].fill && !i.original).slice(0, limit)) {
    const f = it.layers[0].fill!;
    const res = await readMask(f);
    if (!res) return; // OCR unavailable
    // A reading confirms text only where the detector saw letters to begin
    // with: OCR finds "4 4" in a sparkle too.
    it.verified = res.verified && (it.score >= 45 || it.source !== "detected");
    if (it.verified) {
      it.original = res.text;
      it.score = Math.round(it.score * 2.5);
      it.confident = true;
      // Knowing the words, find the bundled font whose shapes are closest.
      try {
        const fm = await matchFont(res.text, f, it.style);
        if (fm) {
          const untouched = it.style === it.matched;
          it.matched = { ...it.matched, font: fm.font, weight: fm.weight };
          if (untouched) it.style = it.matched;
        }
      } catch { /* keep the default font */ }
    } else {
      // Unread. OCR knows English letters only and stumbles on heavy
      // effects, so a strong detection keeps its standing; a weak one,
      // probably an ornament, drops down the list.
      if (res.text && res.confidence >= 50) it.original = res.text;
      // Ornaments on their own layer score well too (a gift box, a gem), so
      // only a very strong detection stands without a reading.
      const strong = it.score >= 400 || (it.kind === "hidden" && it.score >= 150);
      if (!strong) {
        it.score = Math.round(it.score * (res.confidence < 35 ? 0.4 : 0.7));
        it.confident = false;
      } else it.confident = true;
    }
    onRead(it);
  }
}

/* ------------------------------------------------------------------ */
/* Picking text by hand                                                    */
/* ------------------------------------------------------------------ */

/**
 * The text under a box drawn on the stage (viewBox coordinates, at `frame`).
 * The top-most sprite there that has lettering inside the box owns it;
 * other sprites with lettering at the same spot become companion layers.
 * Falls back to the top-most opaque sprite (the box is erased and drawn in).
 */
export async function itemFromRect(movie: MovieFile, frame: number, rect: Rect): Promise<TextItem | null> {
  const sprites = spritesOf(movie);
  type Hit = { key: string; region: Rect; t: Transform; line: TextLine | null; cover: number; seqKeys: string[] };
  const hits: Hit[] = [];
  const rasters = new Map<string, Raster>();
  for (const k of Object.keys(movie.images)) { const r = await rasterOfBytes(movie.images[k]); if (r) rasters.set(k, r); }
  const sizes = new Map([...rasters].map(([k, r]) => [k, { width: r.width, height: r.height }]));
  const uses = imageUses(movie, sizes);
  const seq = sequences(uses, sizes, Math.max(1, movie.params.frames));
  for (let si = sprites.length - 1; si >= 0; si--) {
    const s = sprites[si];
    const f = s.frames[frame];
    if (!f || f.alpha <= MIN_ALPHA) continue;
    const key = resolveImageKey(movie, s.imageKey);
    const r = key ? rasters.get(key) : null;
    if (!key || !r) continue;
    const inv = invert(f.transform);
    if (!inv) continue;
    const region = clampRect(mapRect(inv, rect), r.width, r.height);
    if (region.width < 3 || region.height < 3) continue;
    let opaque = 0, n = 0;
    for (let y = region.y; y < region.y + region.height; y += 2) for (let x = region.x; x < region.x + region.width; x += 2) { n++; if (r.data[(y * r.width + x) * 4 + 3] > 64) opaque++; }
    const cover = n ? opaque / n : 0;
    if (cover < 0.04) continue;
    const lines = findTextLines(r, { within: region, lenient: true, minGlyph: 4 });
    const found = lines.sort((a, b) => b.score - a.score)[0] ?? null;
    const line = found ? growLine(r, found) : null;
    hits.push({ key, region, t: f.transform, line, cover, seqKeys: seq.get(key) ?? [key] });
  }
  if (!hits.length) return null;
  const owner = hits.find((h) => h.line && h.line.score > 0) ?? hits.find((h) => h.cover > 0.3) ?? hits[0];
  const ownerR = rasters.get(owner.key)!;
  const clear = !!owner.line && ownLayer(ownerR, owner.line);
  const region = owner.line ? padLine(owner.line.box, owner.line.height, ownerR.width, ownerR.height) : owner.region;
  // Keep the user's box when it is clearly bigger than what was found: they meant all of it.
  const finalRegion = owner.line && owner.region.width * owner.region.height > region.width * region.height * 2.2 ? owner.region : region;
  const layers: ItemLayer[] = [{
    key: owner.key, keys: owner.seqKeys, region: finalRegion, role: "main", erase: clear ? "clear" : "inpaint",
    fill: owner.line ? lineMask(owner.line) : null, glyphs: owner.line?.glyphs ?? [], transform: owner.t,
  }];
  const ownerBox = mapRect(owner.t, owner.line?.box ?? finalRegion);
  for (const h of hits) {
    if (h === owner || !h.line || h.key === owner.key) continue;
    const hb = mapRect(h.t, h.line.box);
    if (iou(hb, ownerBox) < 0.45) continue;
    const hr = rasters.get(h.key)!;
    const hc = ownLayer(hr, h.line);
    layers.push({ key: h.key, keys: h.seqKeys, region: padLine(h.line.box, h.line.height, hr.width, hr.height), role: "companion", erase: hc ? "clear" : "inpaint", fill: lineMask(h.line), glyphs: h.line.glyphs, transform: h.t });
  }
  const it = baseItem({ kind: clear ? "layer" : "painted", source: "manual", frame, layers, canvasBox: ownerBox, score: 2000, confident: true });
  await measureItem(movie, it, rasters);
  return it;
}

/** Resize/move an item's main region (bitmap px); companions follow through the canvas. */
export function withRegion(it: TextItem, region: Rect): TextItem {
  const main = it.layers[0];
  const layers = it.layers.map((l, i) => {
    if (i === 0) return { ...l, region };
    // Map the change through the canvas into the companion's pixels.
    const tMain = main.transform, inv = invert(l.transform);
    if (!inv) return l;
    const c = mapRect(inv, mapRect(tMain, region));
    return { ...l, region: { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.width), height: Math.round(c.height) } };
  });
  return { ...it, layers, canvasBox: mapRect(main.transform, region) };
}

/* ------------------------------------------------------------------ */
/* Applying edits                                                          */
/* ------------------------------------------------------------------ */

export const isEdited = (it: TextItem) => it.remove || !!it.text.trim();

/**
 * Where the main layer's text sits: its box is the region, and the baseline
 * and centre are kept relative to it, so the text follows the box when it is
 * moved or resized on the stage.
 */
export function mainAnchor(it: TextItem): Anchor {
  const reg = it.layers[0].region;
  if (it.anchor) return { box: reg, baseline: reg.y + it.anchor.baseline * reg.height, cx: reg.x + it.anchor.cx * reg.width };
  // Slots: centred in the empty bitmap, the way players draw dynamic text.
  return { box: reg, baseline: reg.y + reg.height / 2 + it.style.capHeight / 2, cx: reg.x + reg.width / 2 };
}

/** Where to draw on one layer, mapped from the main layer's anchor through the canvas. */
function layerAnchor(it: TextItem, layer: ItemLayer): { anchor: Anchor; scale: number } {
  const main = it.layers[0];
  const base = mainAnchor(it);
  if (layer === main) return { anchor: base, scale: 1 };
  const inv = invert(layer.transform);
  if (!inv) return { anchor: base, scale: 1 };
  const toLayer = (p: Point) => apply(inv, apply(main.transform, p));
  const box = mapRect(inv, mapRect(main.transform, base.box));
  const bl = toLayer({ x: base.cx, y: base.baseline });
  return { anchor: { box, baseline: bl.y, cx: bl.x }, scale: scaleOf(main.transform) / scaleOf(layer.transform) };
}

function unionRegion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

type Op = { it: TextItem; layer: ItemLayer };

/** Where text effects can reach: within about a quarter letter-height of the known letters. */
function nearZone(layer: ItemLayer, letters: Mask | null = layer.fill): { mask: Mask; radius: number } | null {
  if (!letters || !maskCount(letters)) return null;
  const h = layer.glyphs.length ? Math.max(...layer.glyphs.map((g) => g.height)) : layer.region.height * 0.6;
  return { mask: letters, radius: Math.max(2, Math.ceil(h * 0.22)) };
}

/** Both masks on one frame. */
function unionMasks(a: Mask, b: Mask): Mask {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height);
  const out = expandMask(a, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  orMask(out, b);
  return out;
}

/** A mask in one bitmap's pixels, carried onto another bitmap through the canvas (both drawn at their transforms). */
function mapMask(m: Mask, from: Transform, to: Transform, w: number, h: number): Mask | null {
  const invFrom = invert(from), invTo = invert(to);
  if (!invFrom || !invTo) return null;
  const frame = clampRect(mapRect(invTo, mapRect(from, { x: m.x, y: m.y, width: m.width, height: m.height })), w, h);
  if (frame.width < 1 || frame.height < 1) return null;
  const out: Mask = { data: new Uint8Array(frame.width * frame.height), width: frame.width, height: frame.height, x: frame.x, y: frame.y };
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const p = apply(invFrom, apply(to, { x: x + frame.x + 0.5, y: y + frame.y + 0.5 }));
    const sx = Math.floor(p.x) - m.x, sy = Math.floor(p.y) - m.y;
    if (sx >= 0 && sy >= 0 && sx < m.width && sy < m.height && m.data[sy * m.width + sx]) out.data[y * frame.width + x] = 1;
  }
  return out;
}
type Erased = { raster: Raster; presence: Map<ItemLayer, number> };

/** Erased bitmaps, by movie and key, keyed by everything that shaped the erase. */
const eraseCache = new WeakMap<MovieFile, Map<string, { sig: string; erased: Erased }>>();

const rectSig = (r: Rect) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;

/**
 * Every bitmap the edits touch, as pixels: the old letters erased (cached —
 * typing doesn't change what is erased) and the new text drawn. The stage
 * previews these directly; `applyItems` encodes them into the file.
 */
export async function editRasters(movie: MovieFile, items: TextItem[], glyphs: GlyphLibrary | null = null): Promise<Map<string, Raster>> {
  const out = new Map<string, Raster>();
  const ops = new Map<string, Op[]>();
  for (const it of items.filter(isEdited)) {
    const text = it.remove ? "" : it.text.trim();
    if (text && it.lettering === "set" && glyphs && glyphs.key === it.layers[0].key) {
      const src = out.get(glyphs.key) ?? (await rasterOfBytes(movie.images[glyphs.key]));
      if (src) { out.set(glyphs.key, glyphs.compose(text, src)); continue; }
    }
    for (const layer of it.layers) for (const k of layer.keys) (ops.get(k) ?? ops.set(k, []).get(k)!).push({ it, layer });
  }
  if (!ops.size) return out;

  let cache = eraseCache.get(movie);
  if (!cache) eraseCache.set(movie, (cache = new Map()));
  // Per layer: the reference frame's footprint and the text colours.
  const refs = new Map<ItemLayer, { foot: Mask | null; palette: number[][]; presence: number }>();
  const refOf = async (it: TextItem, layer: ItemLayer) => {
    let r = refs.get(layer);
    if (!r) {
      const reference = await rasterOfBytes(movie.images[layer.key]);
      const palette = reference && layer.fill ? maskPalette(reference, layer.fill) : [];
      // A copy of the text (shadow, highlight, a plate with the letters
      // baked in) carries the same letters in the same place: where the
      // main layer's letters land on it counts as letters too.
      const main = it.layers[0];
      let letters = layer.fill;
      if (layer !== main && main.fill && reference) {
        const mapped = mapMask(main.fill, main.transform, layer.transform, reference.width, reference.height);
        if (mapped && maskCount(mapped)) letters = letters ? unionMasks(letters, mapped) : mapped;
      }
      const near = nearZone(layer, letters);
      // A thin band around the letters always goes, then the mask grows to
      // whatever near the letters differs from the background behind them
      // (drop shadow, outline, glow). The work area reaches a little past
      // the region so a shadow at its edge is caught too.
      const hint = letters && near ? dilateMask(letters, Math.max(1, Math.round(near.radius * 0.5))) : letters;
      let foot: Mask | null = null;
      if (reference && layer.erase === "inpaint") {
        const reach = near ? Math.ceil(near.radius * 1.4) : 0;
        const area = letters ? unionRegion(layer.region, { x: letters.x, y: letters.y, width: letters.width, height: letters.height }) : layer.region;
        const frame = clampRect(padRect(area, reach), reference.width, reference.height);
        foot = expandMask(textFootprint(reference, clampRect(area, reference.width, reference.height), { hint, near }), frame);
        // Effects hug the letters; growing further would reach the plate's border.
        if (near) foot = refineFootprint(reference, foot, near.radius);
      }
      r = {
        foot,
        palette,
        presence: reference && layer.fill && layer.keys.length > 1 ? paletteMatch(reference, layer.fill, palette) : 1,
      };
      refs.set(layer, r);
    }
    return r;
  };

  for (const [k, list] of ops) {
    const sig = list.map((o) => `${o.layer.erase}:${o.layer.key}:${rectSig(o.layer.region)}:${o.layer.fill ? maskCount(o.layer.fill) : 0}`).join("|");
    let erased = cache.get(k)?.sig === sig ? cache.get(k)!.erased : null;
    if (!erased) {
      const src = out.get(k) ?? (await rasterOfBytes(movie.images[k]));
      if (!src) continue;
      const r = cloneRaster(src);
      const presence = new Map<ItemLayer, number>();
      for (const { it, layer } of list) {
        if (layer.erase === "clear") {
          clearMask(r, alphaMask(r, layer.region, 0));
        } else if (layer.erase === "inpaint") {
          const ref = await refOf(it, layer);
          let fp: Mask;
          if (k === layer.key && ref.foot) fp = ref.foot;
          else {
            fp = textFootprint(r, layer.region, { textColors: ref.palette, near: nearZone(layer) });
            if (ref.foot) { fp = expandMask(fp, ref.foot); orMask(fp, ref.foot); }
          }
          // Frames where the text fades in or out carry less of it: the new
          // text is drawn as faintly as the old one was.
          if (layer.keys.length > 1 && layer.fill && ref.presence > 0) presence.set(layer, Math.min(1, paletteMatch(src, layer.fill, ref.palette) / ref.presence));
          if (maskCount(fp)) inpaint(r, fp);
        }
      }
      erased = { raster: r, presence };
      cache.set(k, { sig, erased });
    }
    const writes = list.filter((o) => !o.it.remove && o.it.text.trim());
    if (!writes.length) { out.set(k, erased.raster); continue; }
    const canvas = rasterToCanvas(erased.raster);
    const ctx = get2dCtx(canvas);
    for (const { it, layer } of writes) {
      const presence = erased.presence.get(layer) ?? 1;
      if (presence < 0.12) continue;
      const { anchor, scale } = layerAnchor(it, layer);
      const style = layer.role === "main" ? it.style : companionStyle({ ...it.style, capHeight: it.style.capHeight * scale }, layer.color ?? "#000000");
      ctx.save();
      ctx.globalAlpha = presence < 0.85 ? presence : 1;
      await drawText(ctx, it.text.trim(), style, anchor, { x: it.offset.x * scale, y: it.offset.y * scale });
      ctx.restore();
    }
    out.set(k, canvasToRaster(canvas));
  }
  return out;
}

/**
 * Bake every edited item into a copy of the movie. Bitmaps not touched keep
 * their original bytes; touched ones are re-encoded as PNG at the same size.
 */
export async function applyItems(movie: MovieFile, items: TextItem[], glyphs: GlyphLibrary | null = null): Promise<MovieFile> {
  const work = await editRasters(movie, items, glyphs);
  if (!work.size) return movie;
  const images: Record<string, Uint8Array> = { ...movie.images };
  for (const [k, r] of work) images[k] = await encodeLike(movie.images[k], r);
  return { ...movie, images };
}

/**
 * Encode an edited bitmap the way its original was stored: a palette PNG
 * (what most exporters write) stays a 256-colour palette PNG, so editing
 * a 60-frame sequence doesn't double the file; anything else is lossless.
 */
export async function encodeLike(original: Uint8Array | undefined, r: Raster): Promise<Uint8Array> {
  const buf = r.data.slice().buffer as ArrayBuffer;
  const indexed = !!original && original[0] === 0x89 && original[1] === 0x50 && original[25] === 3;
  if (indexed) return new Uint8Array(UPNG.encode([buf], r.width, r.height, 256));
  const viaCanvas = await rasterToPng(r);
  const viaUpng = new Uint8Array(UPNG.encode([buf], r.width, r.height, 0));
  return viaUpng.byteLength < viaCanvas.byteLength ? viaUpng : viaCanvas;
}

/* ------------------------------------------------------------------ */
/* Image slots and layers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Put a picture into a bitmap at the bitmap's own size (players draw at
 * native size): cover-fit, optionally cut to a circle.
 */
export async function fitImage(file: Blob, width: number, height: number, opts: { circle?: boolean; mode?: "cover" | "contain" } = {}): Promise<Uint8Array> {
  const bmp = await createImageBitmap(file);
  const canvas = makeCanvas(width, height);
  const ctx = get2dCtx(canvas);
  const s = (opts.mode ?? "cover") === "cover" ? Math.max(width / bmp.width, height / bmp.height) : Math.min(width / bmp.width, height / bmp.height);
  const w = bmp.width * s, h = bmp.height * s;
  if (opts.circle) {
    ctx.beginPath();
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, (width - w) / 2, (height - h) / 2, w, h);
  bmp.close?.();
  return rasterToPng(canvasToRaster(canvas));
}

/* ------------------------------------------------------------------ */
/* Siblings                                                                */
/* ------------------------------------------------------------------ */

export function isSibling(movie: MovieFile, other: MovieFile): boolean {
  if (other === movie) return false;
  if (Math.round(other.params.viewBoxWidth) !== Math.round(movie.params.viewBoxWidth)) return false;
  if (Math.round(other.params.viewBoxHeight) !== Math.round(movie.params.viewBoxHeight)) return false;
  return Object.keys(other.images).join("\n") === Object.keys(movie.images).join("\n");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Premultiplied difference bounds; transparent pixels' undefined colour never counts. */
export function diffRegion(a: Raster, b: Raster, threshold = 40, pad = 2): Rect | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const { width, height } = a;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const aa = a.data[i + 3] / 255, ab = b.data[i + 3] / 255;
    let delta = Math.abs(a.data[i + 3] - b.data[i + 3]);
    for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[i + c] * aa - b.data[i + c] * ab); if (d > delta) delta = d; }
    if (delta > threshold) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - pad), y = Math.max(0, minY - pad);
  return { x, y, width: Math.min(width, maxX + 1 + pad) - x, height: Math.min(height, maxY + 1 + pad) - y };
}

/**
 * Diff against every same-design sibling and union the regions. A sibling
 * that differs nearly everywhere is another design and is ignored.
 */
async function siblingDiff(movie: MovieFile, siblings: SiblingFile[], rasters: Map<string, Raster>, uses: Map<string, ImageUse>) {
  const same: { name: string; regions: Map<string, Rect> }[] = [];
  for (const s of siblings.filter((c) => isSibling(movie, c.movie))) {
    const regions = new Map<string, Rect>();
    let mismatch = false;
    for (const [k, a] of rasters) {
      const theirs = s.movie.images[k];
      if (!theirs || bytesEqual(movie.images[k], theirs) || !uses.get(k)?.frames.length) continue;
      const b = await rasterOfBytes(theirs);
      if (!b) continue;
      const region = diffRegion(a, b);
      if (!region) continue;
      regions.set(k, region);
      const ink = alphaBounds(a, 8) ?? { x: 0, y: 0, width: a.width, height: a.height };
      const share = (region.width * region.height) / Math.max(1, ink.width * ink.height);
      const label = ink.width / Math.max(1, ink.height) >= 1.2 && share <= 1;
      if (share > 0.6 && !label) mismatch = true;
    }
    if (regions.size && !mismatch) same.push({ name: s.name, regions });
  }
  const regions = new Map<string, Rect>();
  for (const e of same) for (const [k, r] of e.regions) regions.set(k, regions.has(k) ? unionRegion(regions.get(k)!, r) : r);
  return { regions, used: same.length, names: same.map((s) => s.name) };
}

export { inkShare, iou };
