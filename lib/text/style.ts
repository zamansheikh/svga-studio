"use client";

import { fontStack, ensureFont, capRatio } from "./fonts";
import { dilateMask, type Mask } from "./inpaint";
import { hex, luma, median, type Raster, type Rect } from "./raster";

/**
 * How text looks, and how to draw it.
 *
 * `measureLettering` reads the look of the letters being replaced — their
 * height and baseline, slant, stroke weight, fill (flat or a top-to-bottom
 * gradient) and outline — so the new text can be drawn to match. `drawText`
 * draws a string in a `TextStyle` onto a canvas in bitmap coordinates.
 */

export type TextStyle = {
  /** Font id from the registry (or an uploaded font's family). */
  font: string;
  weight: number;
  italic: boolean;
  /** Synthetic slant in degrees (positive leans right), applied on top of the font. */
  slant: number;
  /** Cap height in bitmap px. Font size is derived from it so every font lands at the same height. */
  capHeight: number;
  /** When the text is wider than the box: squeeze it a little first, then shrink; or only shrink. */
  fit: "squeeze" | "shrink" | "none";
  align: "center" | "left" | "right";
  /** Extra space between letters, as a fraction of the font size. */
  letterSpacing: number;
  fill: { mode: "solid" | "gradient"; colors: string[] };
  stroke: { enabled: boolean; color: string; /** fraction of cap height */ width: number };
  shadow: { enabled: boolean; color: string; /** fractions of cap height */ dx: number; dy: number; blur: number };
};

/** Where the text sits in its bitmap: the box it may use and its baseline. */
export type Anchor = { box: Rect; baseline: number; cx: number };

export type Measured = {
  anchor: Anchor;
  capHeight: number;
  slant: number;
  weight: number;
  fill: string[];
  stroke: { color: string; width: number } | null;
  /** Mean colour of the glyph pixels — a companion layer (shadow, highlight) is drawn in this. */
  color: string;
};

export const DEFAULT_STYLE: TextStyle = {
  font: "montserrat",
  weight: 800,
  italic: false,
  slant: 0,
  capHeight: 20,
  fit: "squeeze",
  align: "center",
  letterSpacing: 0,
  fill: { mode: "solid", colors: ["#ffffff"] },
  stroke: { enabled: false, color: "#1a1a2e", width: 0.12 },
  shadow: { enabled: false, color: "#000000", dx: 0.04, dy: 0.08, blur: 0.08 },
};

/* ------------------------------------------------------------------ */
/* Measuring                                                              */
/* ------------------------------------------------------------------ */

/**
 * Read the lettering inside `fill` (the glyph pixels) of `r`. `footprint`
 * (everything that is text — fill, outline, glow) helps find the outline.
 * `glyphs` (per-glyph boxes) gives the baseline.
 */
export function measureLettering(r: Raster, fill: Mask, footprint: Mask | null, glyphs: Rect[], region: Rect): Measured {
  const pts: number[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < fill.height; y++) for (let x = 0; x < fill.width; x++) {
    if (!fill.data[y * fill.width + x]) continue;
    const gx = x + fill.x, gy = y + fill.y;
    pts.push(gx, gy);
    if (gx < x0) x0 = gx; if (gx > x1) x1 = gx; if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
  }
  if (x1 < 0) {
    const cap = Math.max(4, region.height * 0.62);
    return { anchor: { box: region, baseline: region.y + region.height * 0.81, cx: region.x + region.width / 2 }, capHeight: cap, slant: 0, weight: 800, fill: ["#ffffff"], stroke: null, color: "#ffffff" };
  }
  // Baseline: where most glyphs stand (descenders hang below it).
  const baseline = glyphs.length ? median(glyphs.map((g) => g.y + g.height)) : y1 + 1;
  const top = glyphs.length ? Math.min(...glyphs.map((g) => g.y)) : y0;
  const capHeight = Math.max(3, baseline - top);

  // Fill colours by height: top, middle and bottom thirds of the letters.
  const bands: number[][][] = [[], [], []];
  const all: number[][] = [];
  for (let k = 0; k < pts.length; k += 2) {
    const gx = pts[k], gy = pts[k + 1];
    const o = (gy * r.width + gx) * 4;
    if (r.data[o + 3] < 200) continue;
    const c = [r.data[o], r.data[o + 1], r.data[o + 2]];
    all.push(c);
    const t = (gy - top) / Math.max(1, baseline - top);
    bands[t < 0.34 ? 0 : t < 0.67 ? 1 : 2].push(c);
  }
  const med = (cs: number[][]) => (cs.length ? [0, 1, 2].map((i) => median(cs.map((c) => c[i]))) : null);
  const m0 = med(bands[0]), m1 = med(bands[1]), m2 = med(bands[2]), mAll = med(all) ?? [255, 255, 255];
  const dist = (a: number[] | null, b: number[] | null) => (a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : 0);
  const fillColors = m0 && m2 && dist(m0, m2) > 45 ? [m0, m1 ?? mAll, m2].map((c) => hex(c[0], c[1], c[2])) : [hex(mAll[0], mAll[1], mAll[2])];

  // Outline: rings around the fill that are still text, in a colour of their own.
  let stroke: Measured["stroke"] = null;
  if (footprint) {
    const inFoot = (gx: number, gy: number) => {
      const fx = gx - footprint.x, fy = gy - footprint.y;
      return fx >= 0 && fy >= 0 && fx < footprint.width && fy < footprint.height && !!footprint.data[fy * footprint.width + fx];
    };
    const grown: Mask[] = [fill];
    const maxRing = Math.max(2, Math.min(8, Math.round(capHeight * 0.18)));
    for (let k = 1; k <= maxRing; k++) grown.push(dilateMask(grown[k - 1], 1));
    const rings: { share: number; color: number[] | null }[] = [];
    for (let k = 1; k <= maxRing; k++) {
      const outer = grown[k], inner = grown[k - 1];
      const cs: number[][] = [];
      let n = 0, foot = 0;
      for (let y = 0; y < outer.height; y++) for (let x = 0; x < outer.width; x++) {
        const i = y * outer.width + x;
        if (!outer.data[i] || inner.data[i]) continue;
        const gx = x + outer.x, gy = y + outer.y;
        if (gx < 0 || gy < 0 || gx >= r.width || gy >= r.height) continue;
        n++;
        if (!inFoot(gx, gy)) continue;
        foot++;
        const o = (gy * r.width + gx) * 4;
        if (r.data[o + 3] >= 160) cs.push([r.data[o], r.data[o + 1], r.data[o + 2]]);
      }
      rings.push({ share: n ? foot / n : 0, color: med(cs) });
    }
    const first = rings[0];
    if (first && first.share >= 0.55 && first.color && dist(first.color, mAll) > 70) {
      let width = 1;
      for (let k = 1; k < rings.length; k++) {
        if (rings[k].share >= 0.45 && rings[k].color && dist(rings[k].color, first.color) < 90) width++;
        else break;
      }
      stroke = { color: hex(first.color[0], first.color[1], first.color[2]), width: width / capHeight };
    }
  }

  // Slant: the shear that makes the strokes most upright.
  const slant = estimateSlant(pts, baseline);
  // Weight from stroke thickness relative to height.
  const sw = strokeWidthOf(fill);
  const ratio = sw / capHeight;
  const weight = ratio >= 0.21 ? 900 : ratio >= 0.16 ? 800 : ratio >= 0.12 ? 700 : ratio >= 0.09 ? 600 : 500;

  const footBox = footprint ? boundsOf(footprint) : null;
  const box = footBox ? unionBox(region, footBox) : region;
  return {
    anchor: { box, baseline, cx: (x0 + x1 + 1) / 2 },
    capHeight,
    slant,
    weight,
    fill: fillColors,
    stroke,
    color: hex(mAll[0], mAll[1], mAll[2]),
  };
}

function boundsOf(m: Mask): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0 + m.x, y: y0 + m.y, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function unionBox(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Mean stroke width of a mask via a distance transform's ridge. */
function strokeWidthOf(m: Mask): number {
  const { width: w, height: h, data } = m;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = data[i] ? 1e9 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!data[i]) continue; const l = x > 0 ? dist[i - 1] : 0, t = y > 0 ? dist[i - w] : 0; dist[i] = Math.min(dist[i], l + 1, t + 1); }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (!data[i]) continue; const rr = x < w - 1 ? dist[i + 1] : 0, b = y < h - 1 ? dist[i + w] : 0; dist[i] = Math.min(dist[i], rr + 1, b + 1); }
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const d = dist[i]; if (!d) continue; if (d >= dist[i - 1] && d >= dist[i + 1] && d >= dist[i - w] && d >= dist[i + w]) { s += d; n++; } }
  return n ? (s / n) * 2 - 0.5 : 2;
}

/** Degrees of lean, by the shear that maximises the sharpness of the column profile. */
function estimateSlant(pts: number[], baseline: number): number {
  if (pts.length < 40) return 0;
  const scoreAt = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const cols = new Map<number, number>();
    for (let k = 0; k < pts.length; k += 2) {
      const x = Math.round(pts[k] + (pts[k + 1] - baseline) * t);
      cols.set(x, (cols.get(x) ?? 0) + 1);
    }
    let sc = 0;
    for (const v of cols.values()) sc += v * v;
    return sc;
  };
  const upright = scoreAt(0);
  let best = 0, bestScore = upright;
  for (let deg = -8; deg <= 24; deg += 2) {
    if (!deg) continue;
    const sc = scoreAt(deg);
    if (sc > bestScore) { bestScore = sc; best = deg; }
  }
  // Upright unless a lean is clearly better; leaning back is rare, so it must win by more.
  if (bestScore < upright * (best < 0 ? 1.08 : 1.04)) return 0;
  return Math.abs(best) < 4 ? 0 : best;
}

export function styleFromMeasured(m: Measured, base: TextStyle = DEFAULT_STYLE): TextStyle {
  return {
    ...base,
    weight: m.weight,
    slant: m.slant,
    capHeight: m.capHeight,
    fill: { mode: m.fill.length > 1 ? "gradient" : "solid", colors: m.fill },
    stroke: m.stroke ? { enabled: true, color: m.stroke.color, width: Math.min(0.3, m.stroke.width) } : { ...base.stroke, enabled: false },
  };
}

/** A look for a layer that only shadows or highlights the main text: same shape, its own flat colour. */
export function companionStyle(main: TextStyle, color: string): TextStyle {
  return { ...main, fill: { mode: "solid", colors: [color] }, stroke: { ...main.stroke, enabled: false }, shadow: { ...main.shadow, enabled: false } };
}

/* ------------------------------------------------------------------ */
/* Drawing                                                                */
/* ------------------------------------------------------------------ */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function fontString(style: TextStyle, size: number): string {
  return `${style.italic ? "italic " : ""}${style.weight} ${Math.max(1, size).toFixed(2)}px ${fontStack(style.font)}`;
}

export type DrawResult = { ink: Rect; size: number; scaleX: number };

/**
 * Draw `text` into `ctx` (bitmap coordinates) at `anchor` in `style`.
 * The cap height is kept; when the text is wider than the box it is
 * squeezed (down to 78%) and then shrunk, per `style.fit`.
 */
export async function drawText(ctx: Ctx, text: string, style: TextStyle, anchor: Anchor, offset: { x: number; y: number } = { x: 0, y: 0 }): Promise<DrawResult> {
  await ensureFont(style.font, style.weight, style.italic);
  let size = style.capHeight / capRatio(style.font, style.weight, style.italic);
  ctx.save();
  ctx.font = fontString(style, size);
  const spacing = style.letterSpacing * size;
  const measureW = () => {
    ctx.font = fontString(style, size);
    const m = ctx.measureText(text);
    return { w: m.width + Math.max(0, [...text].length - 1) * spacing, m };
  };
  let { w } = measureW();
  const slantPad = Math.abs(Math.tan((style.slant * Math.PI) / 180)) * style.capHeight;
  const strokePad = style.stroke.enabled ? style.stroke.width * style.capHeight * 2 : 0;
  const avail = Math.max(4, anchor.box.width - slantPad - strokePad);
  let sx = 1;
  if (w > avail && style.fit !== "none") {
    if (style.fit === "squeeze") sx = Math.max(0.78, avail / w);
    if (w * sx > avail) { size *= avail / (w * sx); ({ w } = measureW()); }
  }
  const drawnW = w * sx;
  const left = style.align === "left" ? anchor.box.x + strokePad / 2 : style.align === "right" ? anchor.box.x + anchor.box.width - drawnW - strokePad / 2 - slantPad : anchor.cx - drawnW / 2 - slantPad / 2;
  const capNow = size * capRatio(style.font, style.weight, style.italic);
  // Keep the baseline unless the text was shrunk, then centre it on the old letters.
  const baseline = anchor.baseline + offset.y - (style.capHeight - capNow) / 2;
  const x = left + offset.x;

  ctx.translate(x, baseline);
  if (style.slant) ctx.transform(1, 0, -Math.tan((style.slant * Math.PI) / 180), 1, 0, 0);
  if (sx !== 1) ctx.scale(sx, 1);
  ctx.font = fontString(style, size);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  const canSpace = "letterSpacing" in ctx;
  if (canSpace) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${spacing}px`;

  const cap = capNow;
  if (style.shadow.enabled) {
    ctx.shadowColor = style.shadow.color;
    ctx.shadowOffsetX = style.shadow.dx * cap;
    ctx.shadowOffsetY = style.shadow.dy * cap;
    ctx.shadowBlur = style.shadow.blur * cap;
  }
  if (style.stroke.enabled && style.stroke.width > 0) {
    ctx.lineWidth = Math.max(0.5, style.stroke.width * cap * 2);
    ctx.strokeStyle = style.stroke.color;
    ctx.strokeText(text, 0, 0);
    ctx.shadowColor = "transparent";
  }
  if (style.fill.mode === "gradient" && style.fill.colors.length > 1) {
    const g = ctx.createLinearGradient(0, -cap, 0, 0);
    style.fill.colors.forEach((c, i) => g.addColorStop(i / (style.fill.colors.length - 1), c));
    ctx.fillStyle = g;
  } else ctx.fillStyle = style.fill.colors[0] ?? "#ffffff";
  ctx.fillText(text, 0, 0);
  ctx.restore();
  return { ink: { x, y: baseline - cap, width: drawnW + slantPad, height: cap }, size, scaleX: sx };
}

/** Readable text colour on a swatch (for the UI). */
export const onColor = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 0); return luma(r, g, b) > 150 ? "#111" : "#fff"; };
