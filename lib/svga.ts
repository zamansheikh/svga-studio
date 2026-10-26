"use client";

import pako from "pako";
import JSZip from "jszip";
import { Reader, Writer } from "protobufjs/minimal";
import { encodeAudioJson, encodeParams, encodeSpriteJson } from "./movie";

/**
 * An SVGA 2.x file decomposed into the parts we actually touch.
 *
 * We deliberately do NOT use protobufjs with a full schema for the outer
 * MovieEntity — real-world SVGA exporters add extra fields / shape variants
 * that break a strictly-typed decoder. Instead we read the outer message with
 * raw wire-format rules (only field numbers + wire types), and keep every
 * sprite / audio / params sub-message as an opaque byte buffer that we
 * splice back in unchanged when we re-encode. That way the compressor only
 * needs to understand the `images` map, and every other part of the file
 * round-trips byte-for-byte.
 */
export type MovieFile = {
  version: string;
  /** Raw bytes of the MovieParams sub-message — re-emitted unchanged. */
  paramsBytes: Uint8Array;
  /** Convenience fields parsed from paramsBytes. */
  params: {
    viewBoxWidth: number;
    viewBoxHeight: number;
    fps: number;
    frames: number;
  };
  images: Record<string, Uint8Array>;
  /** Raw bytes of each SpriteEntity — preserved untouched. */
  spriteBytes: Uint8Array[];
  /** Raw bytes of each AudioEntity — preserved untouched. */
  audioBytes: Uint8Array[];
  /** How the file was stored — shown to the user; the download is always SVGA 2.x (zlib). */
  source?: { container: "zlib" | "gzip" | "deflate" | "protobuf" | "zip"; version: string; note?: string };
};

const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/**
 * Inflate, keeping whatever a complete stream produced even when junk
 * follows it (some uploaders append bytes; strict inflaters then throw the
 * whole file away). Tries zlib, then gzip, then raw deflate.
 */
function inflateLenient(bytes: Uint8Array): { data: Uint8Array; container: "zlib" | "gzip" | "deflate"; trailing: boolean } | null {
  // Inflate a raw deflate stream. In raw mode pako stops at the end of the
  // stream; with a zlib/gzip wrapper it would try to read whatever follows
  // as another stream and drop the last chunk of good data on the error.
  const raw = (data: Uint8Array, trailer: number) => {
    const chunks: Uint8Array[] = [];
    const inf = new pako.Inflate({ raw: true });
    inf.onData = (c: Uint8Array) => { chunks.push(c); };
    try { inf.push(data, true); } catch { /* keep what was produced */ }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    if (!total) return null;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    // Bytes left after the stream, beyond the wrapper's checksum trailer.
    const left = (inf as unknown as { strm?: { avail_in?: number } }).strm?.avail_in ?? 0;
    return { data: out, trailing: inf.err === 0 && left > trailer };
  };
  if (bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8) {
    const start = gzipHeaderLength(bytes);
    const r = start > 0 ? raw(bytes.subarray(start), 8) : null;
    if (r) return { ...r, container: "gzip" };
  }
  if ((bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0 && !(bytes[1] & 0x20)) {
    const r = raw(bytes.subarray(2), 4);
    if (r) return { ...r, container: "zlib" };
  }
  const r = raw(bytes, 0);
  return r ? { ...r, container: "deflate" } : null;
}

/** Length of a gzip member header (RFC 1952), or -1 when it is malformed. */
function gzipHeaderLength(b: Uint8Array): number {
  const flags = b[3];
  let p = 10;
  if (flags & 4) { if (p + 2 > b.length) return -1; p += 2 + (b[p] | (b[p + 1] << 8)); }
  if (flags & 8) { while (p < b.length && b[p] !== 0) p++; p++; }
  if (flags & 16) { while (p < b.length && b[p] !== 0) p++; p++; }
  if (flags & 2) p += 2;
  return p < b.length ? p : -1;
}

/** Decode any .svga — 2.x (zlib, gzip, raw deflate or bare protobuf) or 1.x (zip) — into a MovieFile. */
export async function decodeSvga(bytes: Uint8Array): Promise<MovieFile> {
  if (!bytes.length) throw new Error("The file is empty.");
  if (isZip(bytes)) return decodeSvga1(bytes);

  const inflated = inflateLenient(bytes);
  let movie: MovieFile | null = null;
  if (inflated) {
    try { movie = parseMovie(inflated.data); } catch { movie = null; }
    if (movie) movie.source = { container: inflated.container, version: movie.version, note: inflated.trailing ? "extra bytes after the animation data were ignored" : undefined };
  }
  if (!movie) {
    // An uncompressed protobuf is still a valid movie to most players.
    try { movie = parseMovie(bytes); movie.source = { container: "protobuf", version: movie.version }; } catch { movie = null; }
  }
  if (!movie) throw new Error("This doesn't look like an SVGA animation — it isn't SVGA 2.x (compressed protobuf) or 1.x (zip).");
  return movie;
}

/** Read a MovieEntity protobuf. Throws when the bytes are not one. */
function parseMovie(inflated: Uint8Array): MovieFile {
  const reader = Reader.create(inflated);

  let version = "";
  let paramsBytes: Uint8Array = new Uint8Array();
  const images: Record<string, Uint8Array> = {};
  const spriteBytes: Uint8Array[] = [];
  const audioBytes: Uint8Array[] = [];

  try {
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const fieldNum = tag >>> 3;
      const wireType = tag & 7;

      if (fieldNum === 1 && wireType === 2) {
        version = reader.string();
      } else if (fieldNum === 2 && wireType === 2) {
        paramsBytes = copyOut(reader.bytes());
      } else if (fieldNum === 3 && wireType === 2) {
        // map<string, bytes> — each entry is itself a length-delimited message.
        const entryBytes = reader.bytes();
        const entry = parseMapEntry(entryBytes);
        if (entry && entry.key) images[entry.key] = entry.value;
      } else if (fieldNum === 4 && wireType === 2) {
        spriteBytes.push(copyOut(reader.bytes()));
      } else if (fieldNum === 5 && wireType === 2) {
        audioBytes.push(copyOut(reader.bytes()));
      } else {
        // Unknown top-level field — safely skip whatever wire type it is.
        reader.skipType(wireType);
      }
    }
  } catch (e) {
    throw new Error(
      `Failed to parse SVGA structure: ${(e as Error).message}. The file may be corrupted.`,
    );
  }

  const params = parseParams(paramsBytes);
  // Arbitrary bytes can parse as a few stray fields; a movie has a canvas and something to draw.
  if (!(params.viewBoxWidth > 0 && params.viewBoxHeight > 0) || (!spriteBytes.length && !Object.keys(images).length)) {
    throw new Error("No SVGA movie in these bytes.");
  }
  return {
    version: version || "2.0.0",
    paramsBytes,
    params,
    images,
    spriteBytes,
    audioBytes,
  };
}

/**
 * SVGA 1.x: a zip with `movie.spec` (JSON) or `movie.binary` (protobuf)
 * plus one file per image and sound. Converted to the 2.x structure, so the
 * editor and the download treat it like any other file.
 */
async function decodeSvga1(bytes: Uint8Array): Promise<MovieFile> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("This SVGA 1.x file (zip) is damaged and can't be opened.");
  }
  const files = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, entry) => { if (!entry.dir) files.set(path.replace(/^.*\//, ""), entry); });
  const fileBytes = async (name: string) => {
    const e = files.get(name) ?? files.get(`${name}.png`) ?? files.get(`${name}.mp3`);
    return e ? new Uint8Array(await e.async("uint8array")) : null;
  };

  const binary = files.get("movie.binary");
  if (binary) {
    const movie = parseMovie(new Uint8Array(await binary.async("uint8array")));
    // Image values are file names in 1.x binaries; resolve them to the files.
    for (const [key, val] of Object.entries(movie.images)) {
      if (sniffImageMime(val) !== "application/octet-stream" && val.byteLength > 64) continue;
      const name = new TextDecoder().decode(val);
      movie.images[key] = (await fileBytes(name)) ?? (await fileBytes(key)) ?? val;
    }
    movie.version = "2.0.0";
    movie.source = { container: "zip", version: "1.x (binary)" };
    return movie;
  }

  const specEntry = files.get("movie.spec");
  if (!specEntry) throw new Error("This zip has no movie.spec or movie.binary, so it isn't an SVGA 1.x file.");
  type Spec = {
    ver?: string;
    movie?: { viewBox?: { width?: number; height?: number }; fps?: number; frames?: number };
    images?: Record<string, string>;
    sprites?: Parameters<typeof encodeSpriteJson>[0][];
    audios?: Parameters<typeof encodeAudioJson>[0][];
  };
  let spec: Spec;
  try {
    spec = JSON.parse(await specEntry.async("string"));
  } catch {
    throw new Error("The movie.spec inside this SVGA 1.x file isn't valid JSON.");
  }
  const params = {
    viewBoxWidth: Number(spec.movie?.viewBox?.width) || 0,
    viewBoxHeight: Number(spec.movie?.viewBox?.height) || 0,
    fps: Number(spec.movie?.fps) || 20,
    frames: Number(spec.movie?.frames) || 0,
  };
  const images: Record<string, Uint8Array> = {};
  for (const [key, name] of Object.entries(spec.images ?? {})) {
    const b = (await fileBytes(String(name))) ?? (await fileBytes(key));
    if (b) images[key] = b;
  }
  for (const a of spec.audios ?? []) {
    if (a.audioKey && !images[a.audioKey]) { const b = await fileBytes(a.audioKey); if (b) images[a.audioKey] = b; }
  }
  const paramsBytes = encodeParams(params);
  return {
    version: "2.0.0",
    paramsBytes,
    params,
    images,
    spriteBytes: (spec.sprites ?? []).map(encodeSpriteJson),
    audioBytes: (spec.audios ?? []).map(encodeAudioJson),
    source: { container: "zip", version: `1.x (${spec.ver ?? "spec"})` },
  };
}

/** Re-serialize a MovieFile back into a gzipped SVGA byte stream. */
export async function encodeSvga(movie: MovieFile): Promise<Uint8Array> {
  const w = Writer.create();

  // field 1 (string version), wire type 2
  w.uint32((1 << 3) | 2).string(movie.version || "2.0.0");
  // field 2 (MovieParams), wire type 2 — emitted verbatim
  w.uint32((2 << 3) | 2).bytes(movie.paramsBytes);
  // field 3 (map entries), wire type 2
  for (const [key, val] of Object.entries(movie.images)) {
    const entry = Writer.create();
    entry.uint32((1 << 3) | 2).string(key);
    entry.uint32((2 << 3) | 2).bytes(val);
    w.uint32((3 << 3) | 2).bytes(entry.finish());
  }
  // field 4 (sprites) — raw passthrough
  for (const s of movie.spriteBytes) w.uint32((4 << 3) | 2).bytes(s);
  // field 5 (audios) — raw passthrough
  for (const a of movie.audioBytes) w.uint32((5 << 3) | 2).bytes(a);

  return pako.deflate(w.finish(), { level: 9 });
}

function parseMapEntry(bytes: Uint8Array): { key: string; value: Uint8Array } | null {
  try {
    const r = Reader.create(bytes);
    let key = "";
    let value: Uint8Array = new Uint8Array();
    while (r.pos < r.len) {
      const tag = r.uint32();
      const f = tag >>> 3;
      const wt = tag & 7;
      if (f === 1 && wt === 2) key = r.string();
      else if (f === 2 && wt === 2) value = copyOut(r.bytes());
      else r.skipType(wt);
    }
    return { key, value };
  } catch {
    return null;
  }
}

function parseParams(bytes: Uint8Array): MovieFile["params"] {
  const out = { viewBoxWidth: 0, viewBoxHeight: 0, fps: 20, frames: 0 };
  if (!bytes.length) return out;
  try {
    const r = Reader.create(bytes);
    while (r.pos < r.len) {
      const tag = r.uint32();
      const f = tag >>> 3;
      const wt = tag & 7;
      // The spec says fps and frames are int32 (varints) and the canvas size
      // floats; exporters disagree, so accept either encoding for each.
      const v = wt === 5 ? r.float() : wt === 0 ? r.int32() : (r.skipType(wt), null);
      if (v == null) continue;
      if (f === 1) out.viewBoxWidth = v;
      else if (f === 2) out.viewBoxHeight = v;
      else if (f === 3) out.fps = v;
      else if (f === 4) out.frames = Math.round(v);
    }
  } catch {
    /* tolerate partial params */
  }
  return out;
}

/**
 * protobufjs `Reader.bytes()` returns a subarray view into the underlying
 * inflated buffer. We copy it so downstream mutation / buffer re-use is safe
 * and so GC can free the source buffer after decode completes.
 */
function copyOut(view: Uint8Array): Uint8Array {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

/** Detect image mime type from magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  return "application/octet-stream";
}

export function imagesByteSize(movie: MovieFile): number {
  let n = 0;
  for (const k in movie.images) n += movie.images[k].byteLength;
  return n;
}

/* ----------------------------------------------------------------------------
 * Sprite transform rescaling
 *
 * SVGA players render images at the bitmap's *native* dimensions and apply
 * each frame's 2×3 affine transform to position/scale on-canvas. If we
 * downscale a bitmap from W×H to (W·s)×(H·s), the player would render it at
 * s× the intended size in the original transform's reference frame. We
 * compensate by multiplying the transform's 2×2 portion (a, b, c, d) by 1/s
 * so the output pixels end up exactly where the player originally expected.
 *
 * Translations (tx, ty), clip paths and shape layers are all in *output*
 * coordinate space and are deliberately left untouched.
 *
 * Implementation is low-level so any unknown/private sprite fields pass
 * through byte-for-byte.
 * ------------------------------------------------------------------------- */

export type ImageScale = { sx: number; sy: number };

/**
 * Rewrite every FrameEntity.transform inside a raw SpriteEntity byte stream,
 * compensating for image rescaling. Every other field — imageKey, matteKey,
 * layout, clipPath, shapes, and anything unknown — is preserved exactly.
 *
 * @param scaleMap per-imageKey actual scale factors
 * @param fallback optional scale used when the sprite's imageKey doesn't
 *                 resolve in scaleMap (common when an exporter uses image-map
 *                 keys that don't byte-match the sprite's reference).
 */
export function rescaleSpriteTransforms(
  spriteBytes: Uint8Array,
  scaleMap: Map<string, ImageScale>,
  fallback?: ImageScale,
): Uint8Array {
  // First pass: find the imageKey so we know which scale to apply.
  const imageKey = readSpriteImageKey(spriteBytes);
  const matchedKey =
    scaleMap.has(imageKey)
      ? imageKey
      : scaleMap.has(imageKey.replace(/\.[^.]+$/, ""))
        ? imageKey.replace(/\.[^.]+$/, "")
        : scaleMap.has(imageKey + ".png")
          ? imageKey + ".png"
          : scaleMap.has(imageKey + ".webp")
            ? imageKey + ".webp"
            : scaleMap.has(imageKey + ".jpg")
              ? imageKey + ".jpg"
              : scaleMap.has(imageKey + ".jpeg")
                ? imageKey + ".jpeg"
                : null;
  const scale = matchedKey ? scaleMap.get(matchedKey) : fallback;

  // Dev-only trace so `scale < 1` experiments are debuggable from DevTools.
  if (typeof window !== "undefined") {
    // eslint-disable-next-line no-console
    console.debug(
      `[svga] sprite imageKey="${imageKey}" matched="${matchedKey ?? "(fallback)"}" scale=${
        scale ? `${scale.sx.toFixed(3)}×${scale.sy.toFixed(3)}` : "none"
      }`,
    );
  }

  if (!scale || (scale.sx === 1 && scale.sy === 1)) return spriteBytes;

  const invSx = 1 / scale.sx;
  const invSy = 1 / scale.sy;

  const reader = Reader.create(spriteBytes);
  const writer = Writer.create();

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;

    if (fieldNum === 2 && wireType === 2) {
      // FrameEntity — patch its transform and re-emit.
      const frameBytes = reader.bytes();
      const rewritten = rewriteFrame(toStandalone(frameBytes), invSx, invSy);
      writer.uint32(tag).bytes(rewritten);
    } else if (wireType === 2) {
      // imageKey, matteKey, or unknown length-delimited field — pass through.
      writer.uint32(tag).bytes(reader.bytes());
    } else if (wireType === 0) {
      writer.uint32(tag).int64(reader.int64());
    } else if (wireType === 1) {
      writer.uint32(tag).fixed64(reader.fixed64());
    } else if (wireType === 5) {
      writer.uint32(tag).fixed32(reader.fixed32());
    } else {
      reader.skipType(wireType);
    }
  }

  return writer.finish();
}

export function readSpriteImageKey(spriteBytes: Uint8Array): string {
  const r = Reader.create(spriteBytes);
  while (r.pos < r.len) {
    const tag = r.uint32();
    const f = tag >>> 3;
    const wt = tag & 7;
    if (f === 1 && wt === 2) return r.string();
    r.skipType(wt);
  }
  return "";
}

/**
 * Re-point a sprite at a different bitmap (imageKey, and matteKey when it
 * is being merged too). Every other field passes through byte-for-byte.
 */
export function rewriteSpriteKeys(spriteBytes: Uint8Array, remap: Map<string, string>): Uint8Array {
  const reader = Reader.create(spriteBytes);
  const writer = Writer.create();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const f = tag >>> 3;
    const wt = tag & 7;
    if ((f === 1 || f === 3) && wt === 2) {
      const key = reader.string();
      writer.uint32(tag).string(remap.get(key) ?? key);
    } else if (wt === 2) {
      writer.uint32(tag).bytes(reader.bytes());
    } else if (wt === 0) {
      writer.uint32(tag).int64(reader.int64());
    } else if (wt === 1) {
      writer.uint32(tag).fixed64(reader.fixed64());
    } else if (wt === 5) {
      writer.uint32(tag).fixed32(reader.fixed32());
    } else {
      reader.skipType(wt);
    }
  }
  return writer.finish();
}

/* ----------------------------------------------------------------------------
 * Compressor extras: dedupe + metadata
 * ------------------------------------------------------------------------- */

/**
 * Store byte-identical bitmaps once and re-point the sprites that used the
 * duplicates. Exporters often embed the same PNG under several keys.
 */
export function dedupeImages(movie: MovieFile): { movie: MovieFile; merged: number } {
  const keys = Object.keys(movie.images);
  const survivors: { key: string; bytes: Uint8Array }[] = [];
  const remap = new Map<string, string>();
  for (const key of keys) {
    const bytes = movie.images[key];
    const twin = survivors.find((s) => s.bytes.byteLength === bytes.byteLength && bytesEqual(s.bytes, bytes));
    if (twin) remap.set(key, twin.key);
    else survivors.push({ key, bytes });
  }
  if (!remap.size) return { movie, merged: 0 };
  const images: Record<string, Uint8Array> = {};
  for (const s of survivors) images[s.key] = s.bytes;
  const spriteBytes = movie.spriteBytes.map((s) => {
    const key = readSpriteImageKey(s);
    return remap.has(key) ? rewriteSpriteKeys(s, remap) : s;
  });
  return { movie: { ...movie, images, spriteBytes }, merged: remap.size };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** How many fields beyond the four the schema defines sit in MovieParams. */
export function paramsExtraFieldCount(paramsBytes: Uint8Array): number {
  let n = 0;
  try {
    const r = Reader.create(paramsBytes);
    while (r.pos < r.len) {
      const tag = r.uint32();
      const f = tag >>> 3;
      r.skipType(tag & 7);
      if (f < 1 || f > 4) n++;
    }
  } catch {
    /* tolerate */
  }
  return n;
}

/**
 * Drop unknown MovieParams fields. Some exporters put a base64 JSON tag there
 * with the tool name, author email and timestamp — provenance to some,
 * a tracking tag to others.
 */
export function stripParamsMetadata(paramsBytes: Uint8Array): { bytes: Uint8Array; removed: number } {
  const reader = Reader.create(paramsBytes);
  const writer = Writer.create();
  let removed = 0;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const f = tag >>> 3;
    const wt = tag & 7;
    const keep = f >= 1 && f <= 4;
    if (!keep) removed++;
    if (wt === 2) {
      const b = reader.bytes();
      if (keep) writer.uint32(tag).bytes(b);
    } else if (wt === 0) {
      const v = reader.int64();
      if (keep) writer.uint32(tag).int64(v);
    } else if (wt === 1) {
      const v = reader.fixed64();
      if (keep) writer.uint32(tag).fixed64(v);
    } else if (wt === 5) {
      const v = reader.fixed32();
      if (keep) writer.uint32(tag).fixed32(v);
    } else {
      reader.skipType(wt);
    }
  }
  return { bytes: writer.finish(), removed };
}

function rewriteFrame(frameBytes: Uint8Array, invSx: number, invSy: number): Uint8Array {
  const reader = Reader.create(frameBytes);
  const writer = Writer.create();

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;

    if (fieldNum === 3 && wireType === 2) {
      // Transform — read 6 floats, scale 2×2, re-emit.
      const tBytes = reader.bytes();
      writer.uint32(tag).bytes(rewriteTransform(toStandalone(tBytes), invSx, invSy));
    } else if (wireType === 2) {
      // layout, clipPath, shapes, or unknown — pass through.
      writer.uint32(tag).bytes(reader.bytes());
    } else if (wireType === 0) {
      writer.uint32(tag).int64(reader.int64());
    } else if (wireType === 1) {
      writer.uint32(tag).fixed64(reader.fixed64());
    } else if (wireType === 5) {
      // alpha (fixed32 float) — preserve exact bit pattern.
      writer.uint32(tag).fixed32(reader.fixed32());
    } else {
      reader.skipType(wireType);
    }
  }

  return writer.finish();
}

function rewriteTransform(
  transformBytes: Uint8Array,
  invSx: number,
  invSy: number,
): Uint8Array {
  // proto3 scalar defaults are 0.
  let a = 0, b = 0, c = 0, d = 0, tx = 0, ty = 0;
  const reader = Reader.create(transformBytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 5) {
      const v = reader.float();
      if (fieldNum === 1) a = v;
      else if (fieldNum === 2) b = v;
      else if (fieldNum === 3) c = v;
      else if (fieldNum === 4) d = v;
      else if (fieldNum === 5) tx = v;
      else if (fieldNum === 6) ty = v;
    } else {
      reader.skipType(wireType);
    }
  }

  // Matrix applied as: x' = a·x + c·y + tx  /  y' = b·x + d·y + ty
  // Shrinking the source bitmap by (sx, sy) means new source coords relate
  // to old by x_old = x_new / sx, so the equivalent output-preserving matrix
  // has each column scaled by 1/sx (x-column: a, b) and 1/sy (y-column: c, d).
  a *= invSx;
  b *= invSx;
  c *= invSy;
  d *= invSy;

  const w = Writer.create();
  w.uint32((1 << 3) | 5).float(a);
  w.uint32((2 << 3) | 5).float(b);
  w.uint32((3 << 3) | 5).float(c);
  w.uint32((4 << 3) | 5).float(d);
  w.uint32((5 << 3) | 5).float(tx);
  w.uint32((6 << 3) | 5).float(ty);
  return w.finish();
}

/**
 * protobufjs `Reader.bytes()` returns a subarray view. Copy it into a fresh
 * buffer so `Reader.create` on the result works independently of how the
 * original buffer gets aliased later.
 */
function toStandalone(view: Uint8Array): Uint8Array {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}
