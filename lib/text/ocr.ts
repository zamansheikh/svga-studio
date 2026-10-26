"use client";

import { get2dCtx, makeCanvas } from "./raster";

/**
 * Reading text with OCR (tesseract.js, served from /ocr by this site).
 *
 * Whole frames of game art defeat OCR; a clean black-on-white image of the
 * letters the detector already isolated does not. So OCR is used to read
 * and confirm a found line — "OFFICIAL", "VIP 5" — never to search. It
 * loads on first use, in a worker, and its absence (offline, blocked) only
 * means lines go unread.
 */

type Worker = { recognize: (img: Blob, opts?: object) => Promise<{ data: { text: string; confidence: number } }>; setParameters: (p: Record<string, string>) => Promise<unknown> };

let workerPromise: Promise<Worker | null> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker | null> {
  if (!workerPromise) {
    workerPromise = (async () => {
      try {
        const T = await import("tesseract.js");
        const base = `${location.origin}/ocr`;
        const w = (await T.createWorker("eng", 1, {
          workerPath: `${base}/worker.min.js`,
          corePath: `${base}/core`,
          langPath: `${base}/lang`,
          gzip: true,
          logger: () => {},
          errorHandler: () => {},
        })) as unknown as Worker;
        await w.setParameters({ tessedit_pageseg_mode: "7", preserve_interword_spaces: "1" });
        return w;
      } catch {
        return null;
      }
    })();
  }
  return workerPromise;
}

export type Reading = { text: string; confidence: number; verified: boolean };

/** Read one line of glyph mask (1 = ink). Resolves null when OCR is unavailable. */
export function readMask(mask: { data: Uint8Array; width: number; height: number }): Promise<Reading | null> {
  const job = queue.then(async () => {
    const w = await getWorker();
    if (!w) return null;
    const blob = await maskToPng(mask);
    try {
      const { data } = await w.recognize(blob);
      const text = data.text.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.!?)]+$/gu, "").trim();
      const alnum = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
      const verified = data.confidence >= 70 && alnum >= 2 && alnum / Math.max(1, text.replace(/ /g, "").length) >= 0.7;
      return { text, confidence: Math.round(data.confidence), verified };
    } catch {
      return null;
    }
  });
  queue = job.catch(() => null);
  return job;
}

async function maskToPng(mask: { data: Uint8Array; width: number; height: number }): Promise<Blob> {
  // Glyphs about 48px tall read best; pad generously.
  const s = Math.max(1, Math.min(6, 48 / Math.max(1, mask.height)));
  const pad = 16;
  const src = makeCanvas(mask.width, mask.height);
  const sctx = get2dCtx(src);
  const img = sctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i] ? 0 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const w = Math.round(mask.width * s) + pad * 2, h = Math.round(mask.height * s) + pad * 2;
  const dst = makeCanvas(w, h);
  const ctx = get2dCtx(dst);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src as CanvasImageSource, pad, pad, mask.width * s, mask.height * s);
  if ("convertToBlob" in dst) return (dst as OffscreenCanvas).convertToBlob({ type: "image/png" });
  return new Promise((res, rej) => (dst as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}
