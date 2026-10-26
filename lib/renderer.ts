"use client";

import { sniffImageMime, type MovieFile } from "./svga";
import { decodeAudio, decodeSprite, type Audio, type Frame, type Shape, type Sprite, type Transform } from "./movie";

export type { Frame, Sprite } from "./movie";

/* ------------------------------------------------------------------ */
/* Shared decoding caches                                                */
/* ------------------------------------------------------------------ */

const spriteCache = new WeakMap<MovieFile, Sprite[]>();
const spriteBytesCache = new WeakMap<Uint8Array, Sprite | null>();

/**
 * Every sprite with its frames and shapes. Sprites that fail to decode are
 * left out rather than failing the movie. Cached per movie, and per sprite
 * byte buffer, so an edited copy of a movie reuses the work.
 */
export function spritesOf(movie: MovieFile): Sprite[] {
  let out = spriteCache.get(movie);
  if (out) return out;
  out = [];
  for (const raw of movie.spriteBytes) {
    let s = spriteBytesCache.get(raw);
    if (s === undefined) {
      try { s = decodeSprite(raw); } catch { s = null; }
      spriteBytesCache.set(raw, s);
    }
    if (s) out.push(s);
  }
  spriteCache.set(movie, out);
  return out;
}

/** Kept for callers that awaited it. */
export async function decodeSprites(movie: MovieFile): Promise<Sprite[]> {
  return spritesOf(movie);
}

export function audiosOf(movie: MovieFile): Audio[] {
  const out: Audio[] = [];
  for (const raw of movie.audioBytes) { try { out.push(decodeAudio(raw)); } catch { /* skip */ } }
  return out;
}

const bitmapCache = new WeakMap<Uint8Array, Promise<ImageBitmap | null>>();

/** Decode one embedded image, cached by its bytes (edited movies share untouched ones). */
export function bitmapOfBytes(bytes: Uint8Array | undefined): Promise<ImageBitmap | null> {
  if (!bytes) return Promise.resolve(null);
  let p = bitmapCache.get(bytes);
  if (!p) {
    const mime = sniffImageMime(bytes);
    p = mime === "application/octet-stream"
      ? Promise.resolve(null)
      : createImageBitmap(new Blob([bytes as BlobPart], { type: mime })).catch(() => null);
    bitmapCache.set(bytes, p);
  }
  return p;
}

/** Sprite imageKeys sometimes carry an extension the images map lacks, or the other way round. */
export function resolveImageKey(movie: MovieFile, key: string): string | null {
  if (!key) return null;
  if (movie.images[key]) return key;
  const bare = key.replace(/\.[^.]+$/, "");
  if (movie.images[bare]) return bare;
  for (const ext of [".png", ".webp", ".jpg"]) if (movie.images[key + ext]) return key + ext;
  return null;
}

/**
 * Free a movie's decoded bitmaps now rather than at garbage collection —
 * a batch decodes hundreds of files one after another.
 */
export function releaseMovie(movie: MovieFile) {
  for (const bytes of Object.values(movie.images)) {
    const p = bitmapCache.get(bytes);
    if (!p) continue;
    bitmapCache.delete(bytes);
    void p.then((b) => b?.close());
  }
  spriteCache.delete(movie);
}

export type BitmapMap = Map<string, ImageBitmap>;

/** Every image a movie's sprites draw, by sprite imageKey. */
export async function bitmapsOf(movie: MovieFile): Promise<BitmapMap> {
  const map: BitmapMap = new Map();
  const keys = new Set<string>(Object.keys(movie.images));
  for (const s of spritesOf(movie)) if (s.imageKey) keys.add(s.imageKey);
  await Promise.all([...keys].map(async (k) => {
    const resolved = resolveImageKey(movie, k);
    if (!resolved) return;
    const bmp = await bitmapOfBytes(movie.images[resolved]);
    if (bmp) map.set(k, bmp);
  }));
  return map;
}

/* ------------------------------------------------------------------ */
/* Drawing one frame                                                      */
/* ------------------------------------------------------------------ */

export function parseSvgPath(d: string): Path2D | null {
  try {
    return new Path2D(d);
  } catch {
    return null;
  }
}

const pathCache = new Map<string, Path2D | null>();
function cachedPath(d: string): Path2D | null {
  let p = pathCache.get(d);
  if (p === undefined) {
    p = parseSvgPath(d);
    if (pathCache.size > 4000) pathCache.clear();
    pathCache.set(d, p);
  }
  return p;
}

const rgba = (c: { r: number; g: number; b: number; a: number }) =>
  `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function applyTransform(ctx: Ctx, t: Transform) {
  ctx.transform(t.a, t.b, t.c, t.d, t.tx, t.ty);
}

function drawShape(ctx: Ctx, shape: Shape) {
  let path: Path2D | null = null;
  if (shape.type === "shape" && shape.d) path = cachedPath(shape.d);
  else if (shape.type === "rect" && shape.rect) {
    const { x, y, width, height, cornerRadius } = shape.rect;
    path = new Path2D();
    if (cornerRadius > 0 && "roundRect" in path) (path as Path2D & { roundRect: (...a: number[]) => void }).roundRect(x, y, width, height, Math.min(cornerRadius, width / 2, height / 2));
    else path.rect(x, y, width, height);
  } else if (shape.type === "ellipse" && shape.ellipse) {
    const { x, y, radiusX, radiusY } = shape.ellipse;
    path = new Path2D();
    path.ellipse(x, y, Math.abs(radiusX), Math.abs(radiusY), 0, 0, Math.PI * 2);
  }
  if (!path) return;
  ctx.save();
  if (shape.transform) applyTransform(ctx, shape.transform);
  const st = shape.styles;
  if (st?.fill && st.fill.a > 0) {
    ctx.fillStyle = rgba(st.fill);
    ctx.fill(path);
  }
  if (st?.stroke && st.stroke.a > 0 && st.strokeWidth > 0) {
    ctx.strokeStyle = rgba(st.stroke);
    ctx.lineWidth = st.strokeWidth;
    ctx.lineCap = st.lineCap;
    ctx.lineJoin = st.lineJoin;
    if (st.miterLimit > 0) ctx.miterLimit = st.miterLimit;
    if (st.lineDash.length) { ctx.setLineDash([st.lineDash[0], st.lineDash[1]]); ctx.lineDashOffset = st.lineDash[2] ?? 0; }
    ctx.stroke(path);
  }
  ctx.restore();
}

export type DrawOptions = {
  /** Sprites (by index) to leave out — used to hide layers and to isolate one. */
  hidden?: Set<number>;
  /** Only draw these sprite indices. */
  only?: Set<number>;
  /** Replace a sprite's image (by imageKey) for this draw. */
  override?: Map<string, CanvasImageSource>;
};

/** Below this alpha the reference players skip a sprite. */
export const MIN_ALPHA = 0.004;

function drawSprite(ctx: Ctx, sprite: Sprite, frame: Frame, images: BitmapMap, override?: Map<string, CanvasImageSource>) {
  ctx.save();
  ctx.globalAlpha *= frame.alpha;
  applyTransform(ctx, frame.transform);
  if (frame.clipPath) {
    const p = cachedPath(frame.clipPath);
    if (p) ctx.clip(p);
  }
  const img = override?.get(sprite.imageKey) ?? images.get(sprite.imageKey);
  if (img) {
    try { ctx.drawImage(img, 0, 0); } catch { /* closed bitmap */ }
  }
  for (const shape of frame.shapes) drawShape(ctx, shape);
  ctx.restore();
}

let scratch: { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx } | null = null;
function matteLayer(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx } {
  if (!scratch || scratch.canvas.width !== width || scratch.canvas.height !== height) {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d") as Ctx;
    scratch = { canvas, ctx };
  }
  return scratch;
}

/**
 * Draw one frame the way the reference players do: sprites in order, each
 * with its alpha, transform and clip path, its bitmap at native size and its
 * vector shapes on top. Sprites whose imageKey ends in ".matte" are masks:
 * a run of sprites sharing a matteKey is drawn on its own layer, cut by the
 * mask, then composited.
 *
 * `ctx` must already carry the base transform (viewBox → canvas pixels).
 */
export function drawFrame(ctx: Ctx, sprites: Sprite[], images: BitmapMap, frameIndex: number, opts: DrawOptions = {}) {
  const base = ctx.getTransform();
  const mattes = new Map<string, Sprite>();
  for (const s of sprites) if (s.imageKey.endsWith(".matte")) mattes.set(s.imageKey, s);
  const visible = (i: number) => (!opts.only || opts.only.has(i)) && !opts.hidden?.has(i);

  let i = 0;
  while (i < sprites.length) {
    const s = sprites[i];
    if (mattes.has(s.imageKey)) { i++; continue; }
    if (s.matteKey && mattes.has(s.matteKey)) {
      // A run of sprites under the same mask.
      const key = s.matteKey;
      const run: number[] = [];
      while (i < sprites.length && sprites[i].matteKey === key) { run.push(i); i++; }
      const matte = mattes.get(key)!;
      const mf = matte.frames[frameIndex];
      if (!mf || mf.alpha <= MIN_ALPHA) continue;
      const layer = matteLayer(ctx.canvas.width, ctx.canvas.height);
      const lc = layer.ctx;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.globalCompositeOperation = "source-over";
      lc.globalAlpha = 1;
      lc.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      lc.setTransform(base);
      let drew = false;
      for (const k of run) {
        const f = sprites[k].frames[frameIndex];
        if (!f || f.alpha <= MIN_ALPHA || !visible(k)) continue;
        drawSprite(lc, sprites[k], f, images, opts.override);
        drew = true;
      }
      if (!drew) continue;
      lc.globalCompositeOperation = "destination-in";
      drawSprite(lc, matte, mf, images, opts.override);
      lc.globalCompositeOperation = "source-over";
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.restore();
      continue;
    }
    const f = s.frames[frameIndex];
    if (f && f.alpha > MIN_ALPHA && visible(i)) drawSprite(ctx, s, f, images, opts.override);
    i++;
  }
}

/* ------------------------------------------------------------------ */
/* Player                                                                  */
/* ------------------------------------------------------------------ */

export type Renderer = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  isPlaying: () => boolean;
  seek: (frame: number) => void;
  currentFrame: () => number;
  /** Redraw the current frame (after changing draw options). */
  redraw: () => void;
  setOptions: (o: DrawOptions) => void;
  setMuted: (m: boolean) => void;
  onFrame?: (f: number) => void;
  destroy: () => void;
};

export async function createRenderer(bytes: Uint8Array, canvas: HTMLCanvasElement): Promise<Renderer> {
  const { decodeSvga } = await import("./svga");
  return createRendererFromMovie(await decodeSvga(bytes), canvas);
}

export async function createRendererFromMovie(
  movie: MovieFile,
  canvas: HTMLCanvasElement,
  init: { options?: DrawOptions; muted?: boolean; maxPixelRatio?: number; pixelRatio?: number } = {},
): Promise<Renderer> {
  const { viewBoxWidth, viewBoxHeight, fps, frames } = movie.params;
  const sprites = spritesOf(movie);
  const images = await bitmapsOf(movie);

  const safeW = viewBoxWidth > 0 ? viewBoxWidth : 300;
  const safeH = viewBoxHeight > 0 ? viewBoxHeight : 300;
  const dpr = init.pixelRatio ?? Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, init.maxPixelRatio ?? 2);
  canvas.width = Math.max(1, Math.round(safeW * dpr));
  canvas.height = Math.max(1, Math.round(safeH * dpr));
  canvas.style.aspectRatio = `${safeW} / ${safeH}`;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not obtain 2D canvas context");

  let options: DrawOptions = init.options ?? {};
  let playing = false;
  let current = 0;
  let lastTs = 0;
  let rafId = 0;
  const totalFrames = Math.max(1, frames);
  const frameInterval = 1000 / Math.max(1, fps || 20);

  // Sound: each audio entity plays from its start frame to its end frame.
  // The audio elements are only made once sound is wanted (it starts muted).
  type Track = { a: Audio; bytes: Uint8Array; el: HTMLAudioElement | null; url: string | null };
  const tracks: Track[] = [];
  for (const a of audiosOf(movie)) {
    const bytes = movie.images[a.audioKey];
    if (bytes) tracks.push({ a, bytes, el: null, url: null });
  }
  const elementOf = (t: Track) => {
    if (!t.el) {
      t.url = URL.createObjectURL(new Blob([t.bytes as BlobPart], { type: "audio/mpeg" }));
      t.el = new Audio(t.url);
      t.el.preload = "auto";
    }
    return t.el;
  };
  let muted = init.muted ?? true;
  const syncAudio = (f: number, jumped: boolean) => {
    for (const t of tracks) {
      const { a } = t;
      const end = a.endFrame > a.startFrame ? a.endFrame : totalFrames;
      const inside = playing && !muted && f >= a.startFrame && f < end;
      if (inside) {
        const el = elementOf(t);
        if (el.paused || jumped) {
          el.currentTime = Math.max(0, (a.startTime + ((f - a.startFrame) * 1000) / Math.max(1, fps || 20)) / 1000);
          void el.play().catch(() => {});
        }
      } else if (t.el && !t.el.paused) t.el.pause();
    }
  };

  function draw(frameIdx: number) {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrame(ctx, sprites, images, frameIdx, options);
  }

  function tick(ts: number) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const elapsed = ts - lastTs;
    if (elapsed >= frameInterval) {
      const steps = Math.floor(elapsed / frameInterval);
      const next = (current + steps) % totalFrames;
      const wrapped = next < current;
      current = next;
      draw(current);
      syncAudio(current, wrapped);
      api.onFrame?.(current);
      lastTs = ts - (elapsed % frameInterval);
    }
    rafId = requestAnimationFrame(tick);
  }

  draw(0);

  const api: Renderer = {
    canvas,
    width: safeW,
    height: safeH,
    fps,
    totalFrames,
    play() {
      if (playing) return;
      playing = true;
      lastTs = 0;
      syncAudio(current, true);
      rafId = requestAnimationFrame(tick);
    },
    pause() {
      playing = false;
      cancelAnimationFrame(rafId);
      syncAudio(current, false);
    },
    toggle() {
      if (playing) api.pause();
      else api.play();
    },
    isPlaying() {
      return playing;
    },
    seek(f: number) {
      current = Math.max(0, Math.min(totalFrames - 1, Math.floor(f)));
      draw(current);
      syncAudio(current, true);
      api.onFrame?.(current);
    },
    currentFrame() {
      return current;
    },
    redraw() {
      draw(current);
    },
    setOptions(o: DrawOptions) {
      options = o;
      draw(current);
    },
    setMuted(m: boolean) {
      muted = m;
      syncAudio(current, true);
    },
    destroy() {
      api.pause();
      for (const t of tracks) {
        if (!t.el) continue;
        // Stop any load in flight before the URL goes away.
        t.el.pause();
        t.el.removeAttribute("src");
        t.el.load();
        if (t.url) URL.revokeObjectURL(t.url);
        t.el = null;
      }
    },
  };

  return api;
}

/** Render one frame at viewBox scale × `scale` into a fresh canvas (no DPR). */
export async function renderFrameCanvas(movie: MovieFile, frame: number, scale = 1, opts: DrawOptions = {}): Promise<HTMLCanvasElement> {
  const w = Math.max(1, Math.round(movie.params.viewBoxWidth * scale));
  const h = Math.max(1, Math.round(movie.params.viewBoxHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawFrame(ctx, spritesOf(movie), await bitmapsOf(movie), frame, opts);
  return canvas;
}
