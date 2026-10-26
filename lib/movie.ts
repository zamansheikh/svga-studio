import { Reader, Writer } from "protobufjs/minimal";

/**
 * The parts of an SVGA movie a renderer needs: sprites with every frame,
 * vector shapes, masks and audio. Decoded by hand from the wire format so
 * one exotic field (exporters add their own) never sinks the whole file —
 * an unreadable shape is dropped, not the sprite, and an unreadable sprite
 * is dropped, not the movie.
 *
 * The editor never writes these back: sprites keep their original bytes in
 * the MovieFile. Encoding is only used to turn an SVGA 1.x JSON spec into
 * the 2.x sprite bytes the rest of the pipeline expects.
 */

export type RGBA = { r: number; g: number; b: number; a: number };
export type Transform = { a: number; b: number; c: number; d: number; tx: number; ty: number };
export type Layout = { x: number; y: number; width: number; height: number };

export type ShapeStyle = {
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  miterLimit: number;
  /** [dash, gap, offset]; empty when solid. */
  lineDash: number[];
};

export type Shape = {
  type: "shape" | "rect" | "ellipse" | "keep";
  d?: string;
  rect?: { x: number; y: number; width: number; height: number; cornerRadius: number };
  ellipse?: { x: number; y: number; radiusX: number; radiusY: number };
  styles: ShapeStyle | null;
  transform: Transform | null;
};

export type Frame = {
  alpha: number;
  layout: Layout;
  transform: Transform;
  clipPath: string;
  shapes: Shape[];
};

export type Sprite = {
  imageKey: string;
  matteKey: string;
  frames: Frame[];
};

export type Audio = { audioKey: string; startFrame: number; endFrame: number; startTime: number; totalTime: number };

const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/* ------------------------------------------------------------------ */
/* Decoding                                                              */
/* ------------------------------------------------------------------ */

/** Walk a message's fields; `visit` must consume the value or return false to skip it. */
function walk(bytes: Uint8Array, visit: (f: number, wt: number, r: Reader) => boolean): void {
  const r = Reader.create(bytes);
  while (r.pos < r.len) {
    const tag = r.uint32();
    const f = tag >>> 3, wt = tag & 7;
    if (!visit(f, wt, r)) r.skipType(wt);
  }
}

/** A float field, whether the exporter wrote it as fixed32 (spec) or a varint (seen in the wild). */
function num(wt: number, r: Reader): number | null {
  if (wt === 5) return r.float();
  if (wt === 0) return r.int32();
  if (wt === 1) return r.double();
  return null;
}

function readTransform(bytes: Uint8Array): Transform {
  const t = { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 };
  const keys = ["", "a", "b", "c", "d", "tx", "ty"] as const;
  walk(bytes, (f, wt, r) => {
    if (f < 1 || f > 6) return false;
    const v = num(wt, r);
    if (v == null) return false;
    t[keys[f] as keyof Transform] = v;
    return true;
  });
  return t;
}

function readLayout(bytes: Uint8Array): Layout {
  const l = { x: 0, y: 0, width: 0, height: 0 };
  const keys = ["", "x", "y", "width", "height"] as const;
  walk(bytes, (f, wt, r) => {
    if (f < 1 || f > 4) return false;
    const v = num(wt, r);
    if (v == null) return false;
    l[keys[f] as keyof Layout] = v;
    return true;
  });
  return l;
}

function readColor(bytes: Uint8Array): RGBA {
  const c = { r: 0, g: 0, b: 0, a: 0 };
  const keys = ["", "r", "g", "b", "a"] as const;
  walk(bytes, (f, wt, r) => {
    if (f < 1 || f > 4) return false;
    const v = num(wt, r);
    if (v == null) return false;
    c[keys[f] as keyof RGBA] = v;
    return true;
  });
  return c;
}

const CAPS = ["butt", "round", "square"] as const;
const JOINS = ["miter", "round", "bevel"] as const;

function readStyle(bytes: Uint8Array): ShapeStyle {
  const s: ShapeStyle = { fill: null, stroke: null, strokeWidth: 0, lineCap: "butt", lineJoin: "miter", miterLimit: 0, lineDash: [] };
  const dash = [0, 0, 0];
  walk(bytes, (f, wt, r) => {
    if (f === 1 && wt === 2) s.fill = readColor(r.bytes());
    else if (f === 2 && wt === 2) s.stroke = readColor(r.bytes());
    else if (f === 3) { const v = num(wt, r); if (v == null) return false; s.strokeWidth = v; }
    else if (f === 4 && wt === 0) s.lineCap = CAPS[r.int32()] ?? "butt";
    else if (f === 5 && wt === 0) s.lineJoin = JOINS[r.int32()] ?? "miter";
    else if (f === 6) { const v = num(wt, r); if (v == null) return false; s.miterLimit = v; }
    else if (f >= 7 && f <= 9) { const v = num(wt, r); if (v == null) return false; dash[f - 7] = v; }
    else return false;
    return true;
  });
  if (dash[0] || dash[1]) s.lineDash = dash;
  return s;
}

const SHAPE_TYPES = ["shape", "rect", "ellipse", "keep"] as const;

function readShape(bytes: Uint8Array): Shape {
  const shape: Shape = { type: "shape", styles: null, transform: null };
  walk(bytes, (f, wt, r) => {
    if (f === 1 && wt === 0) shape.type = SHAPE_TYPES[r.int32()] ?? "shape";
    else if (f === 2 && wt === 2) walk(r.bytes(), (ff, wwt, rr) => { if (ff === 1 && wwt === 2) { shape.d = rr.string(); return true; } return false; });
    else if (f === 3 && wt === 2) {
      const rect = { x: 0, y: 0, width: 0, height: 0, cornerRadius: 0 };
      const keys = ["", "x", "y", "width", "height", "cornerRadius"] as const;
      walk(r.bytes(), (ff, wwt, rr) => { if (ff < 1 || ff > 5) return false; const v = num(wwt, rr); if (v == null) return false; rect[keys[ff] as keyof typeof rect] = v; return true; });
      shape.rect = rect;
    } else if (f === 4 && wt === 2) {
      const el = { x: 0, y: 0, radiusX: 0, radiusY: 0 };
      const keys = ["", "x", "y", "radiusX", "radiusY"] as const;
      walk(r.bytes(), (ff, wwt, rr) => { if (ff < 1 || ff > 4) return false; const v = num(wwt, rr); if (v == null) return false; el[keys[ff] as keyof typeof el] = v; return true; });
      shape.ellipse = el;
    } else if (f === 10 && wt === 2) shape.styles = readStyle(r.bytes());
    else if (f === 11 && wt === 2) shape.transform = readTransform(r.bytes());
    else return false;
    return true;
  });
  return shape;
}

function readFrame(bytes: Uint8Array): Frame {
  const frame: Frame = { alpha: 0, layout: { x: 0, y: 0, width: 0, height: 0 }, transform: { ...IDENTITY }, clipPath: "", shapes: [] };
  walk(bytes, (f, wt, r) => {
    if (f === 1) { const v = num(wt, r); if (v == null) return false; frame.alpha = v; }
    else if (f === 2 && wt === 2) frame.layout = readLayout(r.bytes());
    else if (f === 3 && wt === 2) frame.transform = readTransform(r.bytes());
    else if (f === 4 && wt === 2) frame.clipPath = r.string();
    else if (f === 5 && wt === 2) {
      const b = r.bytes();
      try { frame.shapes.push(readShape(b)); } catch { /* an exotic shape: leave it out */ }
    } else return false;
    return true;
  });
  return frame;
}

export function decodeSprite(bytes: Uint8Array): Sprite {
  const sprite: Sprite = { imageKey: "", matteKey: "", frames: [] };
  walk(bytes, (f, wt, r) => {
    if (f === 1 && wt === 2) sprite.imageKey = r.string();
    else if (f === 3 && wt === 2) sprite.matteKey = r.string();
    else if (f === 2 && wt === 2) {
      const b = r.bytes();
      try { sprite.frames.push(readFrame(b)); } catch { sprite.frames.push(readFrame(new Uint8Array())); }
    } else return false;
    return true;
  });
  // KEEP: a frame whose shapes say "keep" draws the previous frame's shapes.
  let last: Shape[] = [];
  for (const fr of sprite.frames) {
    if (fr.shapes.some((s) => s.type === "keep")) fr.shapes = last;
    else last = fr.shapes;
  }
  return sprite;
}

export function decodeAudio(bytes: Uint8Array): Audio {
  const a: Audio = { audioKey: "", startFrame: 0, endFrame: 0, startTime: 0, totalTime: 0 };
  walk(bytes, (f, wt, r) => {
    if (f === 1 && wt === 2) a.audioKey = r.string();
    else if (f >= 2 && f <= 5 && wt === 0) {
      const v = r.int32();
      if (f === 2) a.startFrame = v; else if (f === 3) a.endFrame = v; else if (f === 4) a.startTime = v; else a.totalTime = v;
    } else return false;
    return true;
  });
  return a;
}

/* ------------------------------------------------------------------ */
/* Encoding (SVGA 1.x JSON → 2.x bytes)                                  */
/* ------------------------------------------------------------------ */

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function writeFloats(w: Writer, values: (number | undefined)[]) {
  values.forEach((v, i) => { if (isNum(v) && v !== 0) w.uint32(((i + 1) << 3) | 5).float(v); });
}

function encodeColor(c: unknown): Uint8Array | null {
  // 1.x writes [r, g, b, a] in 0..1; tolerate {r,g,b,a} too.
  const arr = Array.isArray(c) ? c : c && typeof c === "object" ? [(c as RGBA).r, (c as RGBA).g, (c as RGBA).b, (c as RGBA).a] : null;
  if (!arr) return null;
  const w = Writer.create();
  writeFloats(w, arr.map(Number));
  return w.finish();
}

function encodeTransformJson(t: Partial<Transform> | undefined): Uint8Array {
  const w = Writer.create();
  const v = { ...IDENTITY, ...(t ?? {}) };
  writeFloats(w, [v.a, v.b, v.c, v.d, v.tx, v.ty]);
  return w.finish();
}

type JsonShape = {
  type?: string;
  args?: { d?: string; x?: number; y?: number; width?: number; height?: number; cornerRadius?: number; radiusX?: number; radiusY?: number };
  styles?: { fill?: unknown; stroke?: unknown; strokeWidth?: number; lineCap?: string; lineJoin?: string; miterLimit?: number; lineDash?: number[] };
  transform?: Partial<Transform>;
};

function encodeShapeJson(s: JsonShape): Uint8Array {
  const w = Writer.create();
  const type = Math.max(0, SHAPE_TYPES.indexOf((s.type ?? "shape") as Shape["type"]));
  if (type) w.uint32((1 << 3) | 0).int32(type);
  const a = s.args ?? {};
  if (type === 0 && a.d) { const sub = Writer.create(); sub.uint32((1 << 3) | 2).string(a.d); w.uint32((2 << 3) | 2).bytes(sub.finish()); }
  if (type === 1) { const sub = Writer.create(); writeFloats(sub, [a.x, a.y, a.width, a.height, a.cornerRadius]); w.uint32((3 << 3) | 2).bytes(sub.finish()); }
  if (type === 2) { const sub = Writer.create(); writeFloats(sub, [a.x, a.y, a.radiusX, a.radiusY]); w.uint32((4 << 3) | 2).bytes(sub.finish()); }
  if (s.styles) {
    const st = Writer.create();
    const fill = encodeColor(s.styles.fill), stroke = encodeColor(s.styles.stroke);
    if (fill) st.uint32((1 << 3) | 2).bytes(fill);
    if (stroke) st.uint32((2 << 3) | 2).bytes(stroke);
    if (isNum(s.styles.strokeWidth)) st.uint32((3 << 3) | 5).float(s.styles.strokeWidth);
    const cap = CAPS.indexOf((s.styles.lineCap ?? "butt") as ShapeStyle["lineCap"]);
    if (cap > 0) st.uint32((4 << 3) | 0).int32(cap);
    const join = JOINS.indexOf((s.styles.lineJoin ?? "miter") as ShapeStyle["lineJoin"]);
    if (join > 0) st.uint32((5 << 3) | 0).int32(join);
    if (isNum(s.styles.miterLimit)) st.uint32((6 << 3) | 5).float(s.styles.miterLimit);
    (s.styles.lineDash ?? []).slice(0, 3).forEach((v, i) => { if (isNum(v)) st.uint32(((7 + i) << 3) | 5).float(v); });
    w.uint32((10 << 3) | 2).bytes(st.finish());
  }
  if (s.transform) w.uint32((11 << 3) | 2).bytes(encodeTransformJson(s.transform));
  return w.finish();
}

type JsonFrame = { alpha?: number; layout?: Partial<Layout>; transform?: Partial<Transform>; clipPath?: string; shapes?: JsonShape[] };

export function encodeSpriteJson(s: { imageKey?: string; matteKey?: string; frames?: JsonFrame[] }): Uint8Array {
  const w = Writer.create();
  if (s.imageKey) w.uint32((1 << 3) | 2).string(s.imageKey);
  for (const fr of s.frames ?? []) {
    const fw = Writer.create();
    if (isNum(fr.alpha) && fr.alpha !== 0) fw.uint32((1 << 3) | 5).float(fr.alpha);
    if (fr.layout) { const lw = Writer.create(); writeFloats(lw, [fr.layout.x, fr.layout.y, fr.layout.width, fr.layout.height]); fw.uint32((2 << 3) | 2).bytes(lw.finish()); }
    if (fr.transform) fw.uint32((3 << 3) | 2).bytes(encodeTransformJson(fr.transform));
    if (fr.clipPath) fw.uint32((4 << 3) | 2).string(fr.clipPath);
    for (const sh of fr.shapes ?? []) fw.uint32((5 << 3) | 2).bytes(encodeShapeJson(sh));
    w.uint32((2 << 3) | 2).bytes(fw.finish());
  }
  if (s.matteKey) w.uint32((3 << 3) | 2).string(s.matteKey);
  return w.finish();
}

export function encodeAudioJson(a: { audioKey?: string; startFrame?: number; endFrame?: number; startTime?: number; totalTime?: number }): Uint8Array {
  const w = Writer.create();
  if (a.audioKey) w.uint32((1 << 3) | 2).string(a.audioKey);
  ([a.startFrame, a.endFrame, a.startTime, a.totalTime] as (number | undefined)[]).forEach((v, i) => { if (isNum(v) && v) w.uint32(((2 + i) << 3) | 0).int32(Math.round(v)); });
  return w.finish();
}

export function encodeParams(p: { viewBoxWidth: number; viewBoxHeight: number; fps: number; frames: number }): Uint8Array {
  const w = Writer.create();
  w.uint32((1 << 3) | 5).float(p.viewBoxWidth);
  w.uint32((2 << 3) | 5).float(p.viewBoxHeight);
  w.uint32((3 << 3) | 0).int32(Math.round(p.fps));
  w.uint32((4 << 3) | 0).int32(Math.round(p.frames));
  return w.finish();
}
