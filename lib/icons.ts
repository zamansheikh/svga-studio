"use client";

import type { MovieFile } from "./svga";
import { bitmapsOf, drawFrame, spritesOf } from "./renderer";

/**
 * Still images ("icons") of SVGA animations.
 *
 * Which frame: by default the most representative one, scored the way the
 * gift library's own preview tool does it — visible pixels weighted by edge
 * detail, so a white flash or a soft glow never wins, and on near-ties the
 * earlier frame. Then the frame is optionally trimmed to its content,
 * placed on a square (or content-shaped) canvas with padding and a
 * background, and encoded.
 */

export type FrameChoice = "best" | "start" | "middle" | "end";

export type IconOptions = {
  frame: FrameChoice;
  /** Longest side in px, or "native": the animation's own canvas pixels. */
  size: number | "native";
  shape: "square" | "content";
  /** Crop away empty (transparent) space around the artwork. */
  trim: boolean;
  /** Space around the artwork, as a fraction of the icon size. */
  padding: number;
  /** null = transparent. */
  background: string | null;
  /** Corner radius of the background, as a fraction of the shorter side. */
  radius: number;
  format: "png" | "webp" | "jpeg";
  /** 0..1, for webp/jpeg. */
  quality: number;
};

export const ICON_PRESETS: { id: string; label: string; hint: string; options: IconOptions }[] = [
  {
    id: "icon",
    label: "App icon",
    hint: "256×256, trimmed, transparent PNG",
    options: { frame: "best", size: 256, shape: "square", trim: true, padding: 0.06, background: null, radius: 0, format: "png", quality: 0.9 },
  },
  {
    id: "preview",
    label: "Full preview",
    hint: "The animation's own canvas size, untrimmed — like the library's .png previews",
    options: { frame: "best", size: "native", shape: "content", trim: false, padding: 0, background: null, radius: 0, format: "png", quality: 0.9 },
  },
  {
    id: "thumb",
    label: "Thumbnail",
    hint: "128×128 WebP, trimmed — small and fast for lists",
    options: { frame: "best", size: 128, shape: "square", trim: true, padding: 0.04, background: null, radius: 0, format: "webp", quality: 0.85 },
  },
  {
    id: "tile",
    label: "Store tile",
    hint: "512×512 on a dark rounded tile, PNG",
    options: { frame: "best", size: 512, shape: "square", trim: true, padding: 0.1, background: "#1b1f2e", radius: 0.18, format: "png", quality: 0.9 },
  },
];

export const DEFAULT_ICON_OPTIONS = ICON_PRESETS[0].options;

export const extensionOf = (o: IconOptions) => (o.format === "jpeg" ? "jpg" : o.format);

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const canvasOf = (w: number, h: number): OffscreenCanvas | HTMLCanvasElement => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement("canvas"), { width: w, height: h });
};
const ctxOf = (c: OffscreenCanvas | HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true }) as Ctx;

/** Draw frame `f` scaled into a canvas whose longest side is `maxSide`. */
async function smallFrame(movie: MovieFile, f: number, maxSide: number) {
  const W = movie.params.viewBoxWidth || 300, H = movie.params.viewBoxHeight || 300;
  const s = Math.min(1, maxSide / Math.max(W, H));
  const c = canvasOf(Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s)));
  const ctx = ctxOf(c);
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawFrame(ctx, spritesOf(movie), await bitmapsOf(movie), f);
  return { c, ctx, s };
}

/** How good a still this frame makes (see the module comment). */
async function frameScore(movie: MovieFile, f: number): Promise<number> {
  const { c, ctx } = await smallFrame(movie, f, 160);
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  let mass = 0;
  for (let i = 3; i < img.length; i += 4) mass += img[i];
  if (!mass) return 0;
  // Detail: the frame over black, 96×96 grey, mean horizontal + vertical difference.
  const g = canvasOf(96, 96);
  const gctx = ctxOf(g);
  gctx.fillStyle = "#000";
  gctx.fillRect(0, 0, 96, 96);
  gctx.drawImage(c as CanvasImageSource, 0, 0, 96, 96);
  const d = gctx.getImageData(0, 0, 96, 96).data;
  const L = new Float32Array(96 * 96);
  for (let i = 0; i < L.length; i++) L[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let dx = 0, dy = 0;
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
    const i = y * 96 + x;
    if (x) dx += Math.abs(L[i] - L[i - 1]);
    if (y) dy += Math.abs(L[i] - L[i - 96]);
  }
  const detail = dx / (96 * 95) + dy / (96 * 95);
  return mass * (detail + 1);
}

/** The frame index for a choice. "best" scores up to `sample` evenly spaced frames. */
export async function pickFrame(movie: MovieFile, choice: FrameChoice, sample = 12): Promise<number> {
  const n = Math.max(1, movie.params.frames);
  if (choice === "start") return firstVisible(movie, 0, 1);
  if (choice === "end") return firstVisible(movie, n - 1, -1);
  if (choice === "middle") return Math.floor(n / 2);
  const idx = n <= sample ? [...Array(n).keys()] : [...new Set(Array.from({ length: sample }, (_, i) => Math.round((i * (n - 1)) / (sample - 1))))];
  let best = 0, bestScore = -1;
  for (const i of idx) {
    const s = await frameScore(movie, i);
    if (s > bestScore * 1.02) { best = i; bestScore = s; }
  }
  return best;
}

/** First frame with anything drawn on it, walking from `from` in `step`. Intros often start empty. */
function firstVisible(movie: MovieFile, from: number, step: 1 | -1): number {
  const n = Math.max(1, movie.params.frames);
  const sprites = spritesOf(movie);
  for (let f = from; f >= 0 && f < n; f += step) if (sprites.some((s) => (s.frames[f]?.alpha ?? 0) > 0.05)) return f;
  return from;
}

/** Bounds of the drawn pixels of a frame, in viewBox units (null when nothing is drawn). */
export async function contentBounds(movie: MovieFile, f: number): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const { c, ctx, s } = await smallFrame(movie, f, 512);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  // One measuring pixel of slack on each side, back in viewBox units.
  const W = movie.params.viewBoxWidth || 300, H = movie.params.viewBoxHeight || 300;
  const bx = Math.max(0, (x0 - 1) / s), by = Math.max(0, (y0 - 1) / s);
  return { x: bx, y: by, width: Math.min(W, (x1 + 2) / s) - bx, height: Math.min(H, (y1 + 2) / s) - by };
}

export type Icon = { blob: Blob; width: number; height: number; frame: number; frames: number; empty: boolean };

const MAX_SIDE = 4096;

/** Render one icon. `frame` overrides the frame choice. */
export async function renderIcon(movie: MovieFile, o: IconOptions, frame?: number | null): Promise<Icon> {
  const frames = Math.max(1, movie.params.frames);
  const f = frame != null ? Math.max(0, Math.min(frames - 1, frame)) : await pickFrame(movie, o.frame);
  const W = movie.params.viewBoxWidth || 300, H = movie.params.viewBoxHeight || 300;
  const bounds = o.trim ? await contentBounds(movie, f) : null;
  const crop = bounds ?? { x: 0, y: 0, width: W, height: H };
  const cw = Math.max(1, crop.width), ch = Math.max(1, crop.height);

  let outW: number, outH: number, s: number;
  if (o.size === "native") {
    s = 1;
    const pad = o.padding * Math.max(cw, ch);
    if (o.shape === "square") outW = outH = Math.max(cw, ch) + 2 * pad;
    else { outW = cw + 2 * pad; outH = ch + 2 * pad; }
  } else {
    const N = o.size;
    const inner = N * (1 - 2 * o.padding);
    s = inner / Math.max(cw, ch);
    if (o.shape === "square") outW = outH = N;
    else { outW = cw * s + 2 * N * o.padding; outH = ch * s + 2 * N * o.padding; }
  }
  // Keep within what canvases and players handle comfortably.
  const cap = Math.min(1, MAX_SIDE / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * cap));
  outH = Math.max(1, Math.round(outH * cap));
  s *= cap;

  const c = canvasOf(outW, outH);
  const ctx = ctxOf(c);
  const bg = o.background ?? (o.format === "jpeg" ? "#ffffff" : null);
  if (bg) {
    ctx.fillStyle = bg;
    const r = Math.min(outW, outH) * Math.max(0, Math.min(0.5, o.radius));
    if (r > 0) {
      ctx.beginPath();
      ctx.roundRect(0, 0, outW, outH, r);
      ctx.fill();
    } else ctx.fillRect(0, 0, outW, outH);
  }
  const ox = (outW - cw * s) / 2, oy = (outH - ch * s) / 2;
  ctx.setTransform(s, 0, 0, s, ox - crop.x * s, oy - crop.y * s);
  ctx.imageSmoothingQuality = "high";
  drawFrame(ctx, spritesOf(movie), await bitmapsOf(movie), f);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const type = o.format === "png" ? "image/png" : o.format === "webp" ? "image/webp" : "image/jpeg";
  const blob = "convertToBlob" in c
    ? await (c as OffscreenCanvas).convertToBlob({ type, quality: o.quality })
    : await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("encoding failed"))), type, o.quality));
  return { blob, width: outW, height: outH, frame: f, frames, empty: o.trim && !bounds };
}

/** A small preview of an image blob for the grid (keeps the full icon out of the page's memory). */
export async function thumbnailOf(blob: Blob, side = 176): Promise<string> {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const c = canvasOf(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
  const ctx = ctxOf(c);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const out = "convertToBlob" in c ? await (c as OffscreenCanvas).convertToBlob({ type: "image/webp", quality: 0.85 }) : await new Promise<Blob>((res) => (c as HTMLCanvasElement).toBlob((b) => res(b!), "image/webp", 0.85));
  return URL.createObjectURL(out);
}

/** Fill a file-name template: {name} = file name without extension, {n} = position, {frame}, {size}. */
export function iconName(template: string, ctx: { name: string; n: number; frame: number; size: string }, ext: string): string {
  const base = (template.trim() || "{name}")
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{n\}/g, String(ctx.n).padStart(3, "0"))
    .replace(/\{frame\}/g, String(ctx.frame))
    .replace(/\{size\}/g, ctx.size)
    .replace(/[\\/:*?"<>|]+/g, "-");
  return `${base || ctx.name}.${ext}`;
}
