"use client";

import type { MovieFile } from "./svga";
import { decodeAudio } from "./movie";
import { readSpriteImageKey } from "./svga";

/**
 * Edits to whole layers: swap a bitmap for another picture (kept at the
 * original pixel size, so every player places it identically), delete a
 * bitmap together with every sprite that draws it, drop a sound.
 */
export type LayerEdits = {
  /** New bytes for an image key. */
  replaced: Record<string, Uint8Array>;
  /** Image keys to delete (with their sprites). */
  removed: string[];
  /** Audio keys to drop. */
  mutedAudio: string[];
};

export const emptyLayerEdits = (): LayerEdits => ({ replaced: {}, removed: [], mutedAudio: [] });

export const hasLayerEdits = (e: LayerEdits) => Object.keys(e.replaced).length > 0 || e.removed.length > 0 || e.mutedAudio.length > 0;

export function applyLayerEdits(movie: MovieFile, e: LayerEdits): MovieFile {
  if (!hasLayerEdits(e)) return movie;
  let out: MovieFile = { ...movie, images: { ...movie.images, ...e.replaced } };
  if (e.removed.length) out = removeBitmaps(out, e.removed);
  if (e.mutedAudio.length) {
    const drop = new Set(e.mutedAudio);
    const audioBytes = out.audioBytes.filter((b) => { try { return !drop.has(decodeAudio(b).audioKey); } catch { return true; } });
    const images = { ...out.images };
    for (const k of drop) delete images[k];
    out = { ...out, audioBytes, images };
  }
  return out;
}

export function removeBitmaps(movie: MovieFile, keys: string[]): MovieFile {
  const drop = new Set(keys);
  const images: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(movie.images)) if (!drop.has(k)) images[k] = v;
  const spriteBytes = movie.spriteBytes.filter((s) => {
    const k = readSpriteImageKey(s);
    return !(drop.has(k) || drop.has(k.replace(/\.[^.]+$/, "")));
  });
  return { ...movie, images, spriteBytes };
}
