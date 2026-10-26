"use client";

import { capRatio, ensureFont, listFonts } from "./fonts";
import { fontString, type TextStyle } from "./style";
import { get2dCtx, makeCanvas } from "./raster";
import type { Mask } from "./inpaint";

/**
 * Which bundled font looks most like the original lettering?
 *
 * Needs the original text (read by OCR). Each candidate font renders that
 * text at the measured letter height and slant; both the rendering and the
 * original glyph mask are scaled to one box and compared pixel by pixel,
 * with a penalty when the font's natural width is far from the original's
 * (a condensed face for condensed lettering). Heuristic, but it separates
 * a serif from a heavy sans from a script reliably.
 */

const W = 160, H = 40;

/** A mask's ink, cropped to its bounds and resampled to W×H (values 0..1). */
function normalise(data: Uint8Array | Uint8ClampedArray, width: number, height: number, alphaStride = 1): { grid: Float32Array; inkW: number; inkH: number } | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  const on = (x: number, y: number) => (alphaStride === 1 ? data[y * width + x] > 0 : data[(y * width + x) * 4 + 3] > 96);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (on(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const iw = x1 - x0 + 1, ih = y1 - y0 + 1;
  const grid = new Float32Array(W * H);
  for (let gy = 0; gy < H; gy++) {
    const sy0 = y0 + (gy / H) * ih, sy1 = y0 + ((gy + 1) / H) * ih;
    for (let gx = 0; gx < W; gx++) {
      const sx0 = x0 + (gx / W) * iw, sx1 = x0 + ((gx + 1) / W) * iw;
      let n = 0, c = 0;
      for (let y = Math.floor(sy0); y < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); y++) for (let x = Math.floor(sx0); x < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); x++) { c++; if (y < height && x < width && on(x, y)) n++; }
      grid[gy * W + gx] = c ? n / c : 0;
    }
  }
  return { grid, inkW: iw, inkH: ih };
}

/**
 * Stroke contrast: the spread of stroke widths along the letters' centre
 * lines (distance-transform ridge), relative to their mean. Sans faces are
 * even; serifs mix thick and thin; scripts swell and taper.
 */
function strokeContrast(on: (x: number, y: number) => boolean, width: number, height: number): number {
  const d = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) d[y * width + x] = on(x, y) ? 1e9 : 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = y * width + x; if (!d[i]) continue; d[i] = Math.min(d[i], (x ? d[i - 1] : 0) + 1, (y ? d[i - width] : 0) + 1, (x && y ? d[i - width - 1] : 0) + 1.414, (y && x < width - 1 ? d[i - width + 1] : 0) + 1.414); }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) { const i = y * width + x; if (!d[i]) continue; d[i] = Math.min(d[i], (x < width - 1 ? d[i + 1] : 0) + 1, (y < height - 1 ? d[i + width] : 0) + 1, (x < width - 1 && y < height - 1 ? d[i + width + 1] : 0) + 1.414, (x && y < height - 1 ? d[i + width - 1] : 0) + 1.414); }
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, v = d[i];
    if (!v || v < d[i - 1] || v < d[i + 1] || v < d[i - width] || v < d[i + width]) continue;
    s += v; s2 += v * v; n++;
  }
  if (n < 5) return 0;
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m)) / m;
}

/** Box blur, twice: shapes compared by structure, not by stroke thickness. */
function blur(g: Float32Array): Float32Array {
  let cur = g;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(cur.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue; s += cur[yy * W + xx]; n++; }
      out[y * W + x] = s / n;
    }
    cur = out;
  }
  return cur;
}

/** Pearson correlation of two blurred grids (−1..1). */
function similarity(a: Float32Array, b: Float32Array): number {
  const A = blur(a), B = blur(b);
  let ma = 0, mb = 0;
  for (let i = 0; i < A.length; i++) { ma += A[i]; mb += B[i]; }
  ma /= A.length; mb /= B.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < A.length; i++) { const x = A[i] - ma, y = B[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export type FontMatch = { font: string; weight: number; score: number; scores: { font: string; score: number }[] };

export async function matchFont(text: string, fill: Mask, style: TextStyle, debug?: { grids: { font: string; grid: Float32Array; score: number }[]; target?: Float32Array }): Promise<FontMatch | null> {
  const t = text.trim();
  if (t.length < 2 || !fill.width || !fill.height) return null;
  const target = normalise(fill.data, fill.width, fill.height);
  if (!target) return null;
  const aspect = target.inkW / Math.max(1, target.inkH);
  const targetContrast = strokeContrast((x, y) => fill.data[y * fill.width + x] > 0, fill.width, fill.height);
  if (debug) debug.target = target.grid;
  const results: { font: string; weight: number; score: number }[] = [];
  for (const f of listFonts()) {
    if (f.category === "system" || f.category === "uploaded") continue;
    const near = (want: number) => f.weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), f.weights[0]);
    for (const weight of [...new Set([near(style.weight), near(style.weight >= 800 ? 600 : 900)])]) {
    await ensureFont(f.id, weight, false);
    const cand: TextStyle = { ...style, font: f.id, weight, italic: false };
    const size = 64 / capRatio(f.id, weight, false);
    const canvas = makeCanvas(Math.ceil(size * (t.length + 2) * 1.1), Math.ceil(size * 1.8));
    const ctx = get2dCtx(canvas);
    ctx.font = fontString(cand, size);
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    ctx.translate(size * 0.3, size * 1.3);
    if (style.slant) ctx.transform(1, 0, -Math.tan((style.slant * Math.PI) / 180), 1, 0, 0);
    ctx.fillText(t, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rendered = normalise(img.data, canvas.width, canvas.height, 4);
    if (!rendered) continue;
    const shape = similarity(target.grid, rendered.grid);
    const ra = rendered.inkW / Math.max(1, rendered.inkH);
    // New text is squeezed to fit anyway, so natural width counts for little.
    const widthFit = Math.exp(-Math.abs(Math.log(ra / aspect)) * 1.6);
    // Render at the original's letter height so stroke widths compare like for like.
    const contrast = strokeContrast((x, y) => img.data[(y * canvas.width + x) * 4 + 3] > 96, canvas.width, canvas.height);
    const contrastFit = Math.exp(-Math.abs(contrast - targetContrast) * 3);
    results.push({ font: f.id, weight, score: Math.max(0, shape) * (0.85 + 0.15 * widthFit) * contrastFit });
    debug?.grids.push({ font: `${f.id}${weight} sh${shape.toFixed(2)} wf${widthFit.toFixed(2)} c${contrast.toFixed(2)}/${targetContrast.toFixed(2)}`, grid: rendered.grid, score: results[results.length - 1].score });
    }
  }
  if (!results.length) return null;
  results.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const perFont = results.filter((r) => (seen.has(r.font) ? false : (seen.add(r.font), true)));
  return { ...perFont[0], scores: perFont.map((r) => ({ font: r.font, score: Math.round(r.score * 1000) / 1000 })) };
}
