"use client";

import { sniffImageMime } from "../svga";
import { canvasToPngBytes, get2dCtx, makeCanvas } from "../watermark";

/** Straight (non-premultiplied) RGBA pixels. */
export type Raster = { data: Uint8ClampedArray; width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

export { makeCanvas, get2dCtx, canvasToPngBytes };

const rasterCache = new WeakMap<Uint8Array, Promise<Raster | null>>();

/** Decode image bytes to pixels, cached by the byte buffer. Null for anything that isn't an image. */
export function rasterOfBytes(bytes: Uint8Array | undefined): Promise<Raster | null> {
  if (!bytes) return Promise.resolve(null);
  let p = rasterCache.get(bytes);
  if (!p) {
    p = (async () => {
      const mime = sniffImageMime(bytes);
      if (mime === "application/octet-stream") return null;
      try {
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const { width, height } = bmp;
        const ctx = get2dCtx(makeCanvas(width, height));
        ctx.drawImage(bmp, 0, 0);
        bmp.close?.();
        const img = ctx.getImageData(0, 0, width, height);
        return { data: img.data, width, height };
      } catch {
        return null;
      }
    })();
    rasterCache.set(bytes, p);
  }
  return p;
}

export function cloneRaster(r: Raster): Raster {
  return { data: new Uint8ClampedArray(r.data), width: r.width, height: r.height };
}

export function blankRaster(width: number, height: number): Raster {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function rasterToCanvas(r: Raster): HTMLCanvasElement | OffscreenCanvas {
  const canvas = makeCanvas(r.width, r.height);
  get2dCtx(canvas).putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return canvas;
}

export function canvasToRaster(canvas: HTMLCanvasElement | OffscreenCanvas): Raster {
  const img = get2dCtx(canvas).getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

export async function rasterToPng(r: Raster): Promise<Uint8Array> {
  return canvasToPngBytes(rasterToCanvas(r));
}

export const clampRect = (r: Rect, w: number, h: number): Rect => {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.width)), y1 = Math.min(h, Math.ceil(r.y + r.height));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
};

export const unionRect = (a: Rect | null | undefined, b: Rect): Rect => {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

export const rectArea = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

export function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export function iou(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  if (!i) return 0;
  const ia = rectArea(i);
  return ia / (rectArea(a) + rectArea(b) - ia);
}

/** Share of `a` covered by `b`. */
export function coverage(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  return i ? rectArea(i) / Math.max(1e-9, rectArea(a)) : 0;
}

export function padRect(r: Rect, px: number, py = px): Rect {
  return { x: r.x - px, y: r.y - py, width: r.width + 2 * px, height: r.height + 2 * py };
}

/** Bounds of pixels with alpha above `threshold`, or null when there are none. */
export function alphaBounds(r: Raster, threshold = 8, within?: Rect): Rect | null {
  const { data, width } = r;
  const area = within ? clampRect(within, r.width, r.height) : { x: 0, y: 0, width: r.width, height: r.height };
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = area.y; y < area.y + area.height; y++) {
    const row = y * width * 4;
    for (let x = area.x; x < area.x + area.width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Share of pixels with alpha above `threshold`. */
export function inkShare(r: Raster, threshold = 8): number {
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] > threshold) n++;
  return n / Math.max(1, r.width * r.height);
}

export const luma = (r: number, g: number, b: number) => (r * 299 + g * 587 + b * 114) / 1000;

export const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

export function parseHex(h: string): [number, number, number] {
  const m = h.replace("#", "");
  const s = m.length === 3 ? m.split("").map((c) => c + c).join("") : m.padEnd(6, "0");
  return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((m, n) => m - n);
  return s[Math.floor(s.length / 2)];
}
