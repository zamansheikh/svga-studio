"use client";

import { get2dCtx, makeCanvas, type Raster, type Rect } from "./raster";

/**
 * Text lines in a bitmap.
 *
 * Game artwork letters its badges in a handful of ways — light letters with
 * a dark outline on a ribbon, dark letters on a light plate, gold letters
 * floating on their own transparent layer. None of them is a clean black on
 * white page, so instead of one threshold the bitmap is cut at several:
 * light-on-dark at a few luma levels, dark-on-light at a few, and the alpha
 * channel itself. Every cut yields blobs; a blob is kept as a glyph when it
 * looks like one (sensible size, sharp edges, one even stroke width), glyphs
 * that share a height and a baseline are chained into lines, and the lines
 * are scored. The same text found at several cuts collapses to its best.
 *
 * Pure pixel code: no DOM besides an optional downscale.
 */

export type Polarity = "light" | "dark" | "alpha";

export type TextLine = {
  /** Tight box around the glyphs, in the raster's pixels. */
  box: Rect;
  glyphs: Rect[];
  /** Effective glyph count (a merged word counts as several). */
  count: number;
  /** Median glyph height. */
  height: number;
  /** Median stroke width, px. */
  strokeWidth: number;
  score: number;
  /** Clean lettering rather than a text-like candidate. */
  confident: boolean;
  polarity: Polarity;
  threshold: number;
  /** Median colour of the glyph pixels. */
  color: [number, number, number];
  /** The glyph pixels inside `box` (1 = ink), at `maskScale` of the raster's resolution. */
  mask?: { data: Uint8Array; width: number; height: number };
  maskScale?: number;
  /** Why each check passed or failed, for the lab. */
  debug?: string;
};

type Comp = {
  x0: number; y0: number; x1: number; y1: number;
  area: number;
  rgb: [number, number, number];
  sw: number; cv: number;
  sharp: number;
  transitions: number;
  label: number;
};

type Channel = { polarity: Polarity; threshold: number; bin: Uint8Array };

export type DetectOptions = {
  /** Downscale bitmaps larger than this before searching (results are scaled back). */
  maxSide?: number;
  /** Only search inside this rect. */
  within?: Rect;
  /** Smallest glyph height worth reporting, px (in the original raster). */
  minGlyph?: number;
  /** Keep weaker candidates too (used when the user points at a spot). */
  lenient?: boolean;
};

export function findTextLines(src: Raster, opts: DetectOptions = {}): TextLine[] {
  const maxSide = opts.maxSide ?? 720;
  let r = src;
  let offX = 0, offY = 0;
  if (opts.within) {
    const w = clampRect(opts.within, src.width, src.height);
    if (w.width < 4 || w.height < 4) return [];
    r = crop(src, w);
    offX = w.x; offY = w.y;
  }
  const scale = Math.min(1, maxSide / Math.max(r.width, r.height));
  if (scale < 1) r = resample(r, scale);
  const lines = detect(r, { minGlyph: Math.max(4, (opts.minGlyph ?? 6) * scale), lenient: !!opts.lenient });
  const k = 1 / scale;
  const map = (b: Rect): Rect => ({ x: Math.round(b.x * k + offX), y: Math.round(b.y * k + offY), width: Math.round(b.width * k), height: Math.round(b.height * k) });
  return lines.map((l) => ({ ...l, box: map(l.box), glyphs: l.glyphs.map(map), height: l.height * k, strokeWidth: l.strokeWidth * k, maskScale: scale }));
}

function clampRect(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.width)), y1 = Math.min(h, Math.ceil(r.y + r.height));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function crop(r: Raster, b: Rect): Raster {
  const data = new Uint8ClampedArray(b.width * b.height * 4);
  for (let y = 0; y < b.height; y++) {
    const s = ((y + b.y) * r.width + b.x) * 4;
    data.set(r.data.subarray(s, s + b.width * 4), y * b.width * 4);
  }
  return { data, width: b.width, height: b.height };
}

function resample(r: Raster, s: number): Raster {
  const w = Math.max(1, Math.round(r.width * s)), h = Math.max(1, Math.round(r.height * s));
  const src = makeCanvas(r.width, r.height);
  get2dCtx(src).putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  const dst = makeCanvas(w, h);
  const ctx = get2dCtx(dst);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { data: img.data, width: w, height: h };
}

/* ------------------------------------------------------------------ */

function detect(r: Raster, o: { minGlyph: number; lenient: boolean }): TextLine[] {
  const { data, width, height } = r;
  const n = width * height;
  const L = new Uint8Array(n);
  const A = new Uint8Array(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    A[i] = a;
    L[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    if (a < 128) transparent++;
  }

  const channels: Channel[] = [];
  const make = (polarity: Polarity, threshold: number, test: (i: number) => boolean) => {
    const bin = new Uint8Array(n);
    let on = 0;
    for (let i = 0; i < n; i++) if (test(i)) { bin[i] = 1; on++; }
    if (on > 8 && on < n * 0.92) channels.push({ polarity, threshold, bin });
  };
  if (transparent > n * 0.15) make("alpha", 128, (i) => A[i] >= 128);
  for (const t of [120, 145, 170, 195, 220]) make("light", t, (i) => A[i] >= 160 && L[i] >= t);
  for (const t of [55, 85, 115]) make("dark", t, (i) => A[i] >= 160 && L[i] <= t);

  const lines: TextLine[] = [];
  const labels = new Int32Array(n);
  for (const ch of channels) {
    const comps = components(r, L, A, ch, labels, o.minGlyph);
    lines.push(...groupLines(comps, r, ch, labels, o.lenient));
  }

  // The same text shows up at several cuts (and as its outline under the
  // other polarity): keep the best of any overlapping set.
  lines.sort((a, b) => b.score - a.score);
  const kept: TextLine[] = [];
  for (const l of lines) {
    if (kept.some((k) => overlap(k.box, l.box) > 0.45)) continue;
    kept.push(l);
  }
  return kept;
}

function overlap(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const i = (x1 - x0) * (y1 - y0);
  return i / Math.min(a.width * a.height, b.width * b.height);
}

/** Connected blobs of one cut that look like glyphs. */
function components(r: Raster, L: Uint8Array, A: Uint8Array, ch: Channel, labels: Int32Array, minGlyph: number): Comp[] {
  const { width, height, data } = r;
  const n = width * height;
  const bin = ch.bin;
  labels.fill(0);
  const out: Comp[] = [];
  const stack = new Int32Array(n);
  let next = 0;
  const maxH = ch.polarity === "alpha" ? height * 1.0 : height * 0.75;
  for (let start = 0; start < n; start++) {
    if (!bin[start] || labels[start]) continue;
    next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, area = 0;
    let rs = 0, gs = 0, bs = 0;
    while (sp) {
      const i = stack[--sp];
      const x = i % width, y = (i - x) / width;
      area++;
      rs += data[i * 4]; gs += data[i * 4 + 1]; bs += data[i * 4 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      // 8-neighbourhood: thin diagonal strokes of italic serifs stay joined.
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || (!dx && !dy)) continue;
          const j = yy * width + xx;
          if (bin[j] && !labels[j]) { labels[j] = next; stack[sp++] = j; }
        }
      }
    }
    // Letters that touch a band of the plate (a highlight along its bottom,
    // an underline) merge with it into one blob. Rows that are one run
    // across nearly the whole blob are the band, not letters: trim them.
    if (x1 - x0 + 1 > (y1 - y0 + 1) * 1.5) {
      const t = trimBars(labels, data, width, next, x0, y0, x1, y1);
      if (t) { y0 = t.y0; y1 = t.y1; area = t.area; rs = t.rgb[0]; gs = t.rgb[1]; bs = t.rgb[2]; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (h < minGlyph || h > maxH || area < 10) continue;
    const fill = area / (w * h);
    if (fill < 0.1 || fill > 0.92) continue;
    if (w > h * 9 || h > w * 9) continue;
    const c: Comp = { x0, y0, x1, y1, area, rgb: [rs / area, gs / area, bs / area], sw: 0, cv: 1, sharp: 0, transitions: 0, label: next };
    measure(c, labels, L, A, width, height, ch.polarity);
    const swr = c.sw / h;
    if (swr < 0.045 || swr > 0.5) continue;
    if (c.cv > 0.85) continue;
    if (c.sharp < (ch.polarity === "alpha" ? 90 : 26)) continue;
    out.push(c);
  }
  return out;
}

function trimBars(labels: Int32Array, data: Uint8ClampedArray, width: number, label: number, x0: number, y0: number, x1: number, y1: number) {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const isBar = (y: number) => {
    let n = 0, runs = 0, on = false;
    for (let x = x0; x <= x1; x++) { const v = labels[y * width + x] === label; if (v) n++; if (v && !on) runs++; on = v; }
    return (n >= w * 0.8 && runs <= 2) || n >= w * 0.9;
  };
  const sparse = (y: number) => { let n = 0; for (let x = x0; x <= x1; x++) if (labels[y * width + x] === label) n++; return n < w * 0.06; };
  let a = y0, b = y1;
  // Skip a few stray pixels at the very edge, then the band itself.
  while (a < b && (isBar(a) || (sparse(a) && a - y0 < h * 0.1))) a++;
  while (b > a && (isBar(b) || (sparse(b) && y1 - b < h * 0.1))) b--;
  if ((a === y0 && b === y1) || b - a + 1 < h * 0.4) return null;
  let area = 0, r = 0, g = 0, bl = 0;
  for (let y = a; y <= b; y++) for (let x = x0; x <= x1; x++) { const i = y * width + x; if (labels[i] !== label) continue; area++; r += data[i * 4]; g += data[i * 4 + 1]; bl += data[i * 4 + 2]; }
  return area ? { y0: a, y1: b, area, rgb: [r, g, bl] } : null;
}

/**
 * Stroke width (distance transform ridge), its spread, edge sharpness and
 * how many strokes a horizontal scan crosses — all within the blob's box.
 */
function measure(c: Comp, labels: Int32Array, L: Uint8Array, A: Uint8Array, width: number, height: number, polarity: Polarity) {
  const bw = c.x1 - c.x0 + 3, bh = c.y1 - c.y0 + 3;
  const inside = new Uint8Array(bw * bh);
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (labels[y * width + x] === c.label) inside[(y - c.y0 + 1) * bw + (x - c.x0 + 1)] = 1;
  const dist = new Float32Array(bw * bh);
  for (let k = 0; k < bw * bh; k++) dist[k] = inside[k] ? 1e9 : 0;
  for (let y = 1; y < bh; y++) for (let x = 1; x < bw - 1; x++) { const k = y * bw + x; if (!inside[k]) continue; dist[k] = Math.min(dist[k], dist[k - 1] + 1, dist[k - bw] + 1, dist[k - bw - 1] + 1.414, dist[k - bw + 1] + 1.414); }
  for (let y = bh - 2; y >= 0; y--) for (let x = bw - 2; x >= 1; x--) { const k = y * bw + x; if (!inside[k]) continue; dist[k] = Math.min(dist[k], dist[k + 1] + 1, dist[k + bw] + 1, dist[k + bw - 1] + 1.414, dist[k + bw + 1] + 1.414); }
  let sum = 0, sum2 = 0, cnt = 0;
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const k = y * bw + x;
    if (!inside[k]) continue;
    const d = dist[k];
    if (d >= dist[k - 1] && d >= dist[k + 1] && d >= dist[k - bw] && d >= dist[k + bw]) { sum += d; sum2 += d * d; cnt++; }
  }
  if (cnt >= 3) {
    const mean = sum / cnt;
    c.sw = mean * 2;
    c.cv = mean ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) / mean : 1;
  }
  // Edge sharpness: across the blob's boundary, how much does the image change?
  let edgeSum = 0, edgeCnt = 0;
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
    const i = y * width + x;
    if (labels[i] !== c.label) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const j = yy * width + xx;
      if (labels[j] === c.label) continue;
      // Two pixels out, past the anti-aliased edge.
      const x2 = x + dx * 2, y2 = y + dy * 2;
      const j2 = x2 >= 0 && y2 >= 0 && x2 < width && y2 < height ? y2 * width + x2 : j;
      const d = polarity === "alpha" ? A[i] - Math.min(A[j], A[j2]) : A[j2] < 128 ? 120 : Math.abs(L[i] - L[j2]);
      edgeSum += Math.max(0, d); edgeCnt++;
    }
  }
  c.sharp = edgeCnt ? edgeSum / edgeCnt : 0;
  // Strokes crossed by scanlines through the middle.
  let t = 0;
  for (const fy of [0.35, 0.5, 0.65]) {
    const y = Math.round(c.y0 + (c.y1 - c.y0) * fy);
    let on = false;
    for (let x = c.x0; x <= c.x1; x++) { const v = labels[y * width + x] === c.label; if (v !== on) { t++; on = v; } }
  }
  c.transitions = t / 3;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

/** Chain glyph blobs into lines and score each line. */
function groupLines(comps: Comp[], r: Raster, ch: Channel, labels: Int32Array, lenient: boolean): TextLine[] {
  if (!comps.length) return [];
  const parent = comps.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i], b = comps[j];
      const ha = a.y1 - a.y0 + 1, hb = b.y1 - b.y0 + 1;
      const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
      if (ov < Math.min(ha, hb) * 0.5) continue;
      // Similar heights — or a capital beside a lowercase letter on the same baseline.
      const sameBase = Math.abs(a.y1 - b.y1) <= Math.max(ha, hb) * 0.15;
      if (Math.max(ha, hb) > Math.min(ha, hb) * (sameBase ? 2.5 : 1.8)) continue;
      const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
      if (gap > Math.max(ha, hb) * 1.4) continue;
      if (Math.max(a.sw, b.sw) > Math.min(a.sw, b.sw) * 2.4) continue;
      parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Comp[]>();
  comps.forEach((c, i) => { const g = find(i); (groups.get(g) ?? groups.set(g, []).get(g)!).push(c); });

  // Mirror twins: ornaments of a symmetric frame repeat left/right; letters don't.
  const mirrored = mirrorTwins(comps, r.width, labels);

  const out: TextLine[] = [];
  for (const grp of groups.values()) {
    // Cut chains that drift off one baseline into separate runs.
    const sorted = [...grp].sort((m, n) => m.x0 - n.x0);
    const runs: Comp[][] = [];
    let run: Comp[] = [];
    for (const c of sorted) {
      if (run.length) {
        const mh = Math.max(...run.map((k) => k.y1 - k.y0 + 1));
        const mid = median(run.map((k) => (k.y0 + k.y1) / 2));
        const base = median(run.map((k) => k.y1));
        const ch2 = c.y1 - c.y0 + 1;
        // On the baseline (any letter, lowercase included), or centred on the line (a descender, a dash).
        const onBase = Math.abs(c.y1 - base) <= mh * 0.2 && ch2 >= mh * 0.38 && ch2 <= mh * 1.8;
        const centred = ch2 >= mh * 0.5 && ch2 <= mh * 1.6 && Math.abs((c.y0 + c.y1) / 2 - mid) <= mh * 0.4;
        const fits = onBase || centred;
        if (!fits) { runs.push(run); run = []; }
      }
      run.push(c);
    }
    if (run.length) runs.push(run);
    for (const g of runs) {
      const l = scoreLine(g, ch, mirrored, lenient, periodicity(g, labels, r.width));
      if (!l) continue;
      const ids = new Set(g.map((c) => c.label));
      const b = l.box;
      const m = new Uint8Array(b.width * b.height);
      for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (ids.has(labels[(y + b.y) * r.width + x + b.x])) m[y * b.width + x] = 1;
      l.mask = { data: m, width: b.width, height: b.height };
      out.push(l);
    }
  }
  return out;
}

function mirrorTwins(comps: Comp[], width: number, labels: Int32Array): Set<Comp> {
  const twins = new Set<Comp>();
  const axis = width / 2;
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i], b = comps[j];
      const wa = a.x1 - a.x0 + 1, ha = a.y1 - a.y0 + 1, wb = b.x1 - b.x0 + 1, hb = b.y1 - b.y0 + 1;
      if (Math.abs(wa - wb) > wa * 0.2 || Math.abs(ha - hb) > ha * 0.2 || Math.abs(a.y0 - b.y0) > ha * 0.2) continue;
      if (Math.abs((a.x0 + a.x1) / 2 + (b.x0 + b.x1) / 2 - 2 * axis) > width * 0.04) continue;
      if (a.x1 >= b.x0 && b.x1 >= a.x0) continue;
      // Mirror a onto b and count agreeing pixels.
      let hit = 0, tot = 0;
      for (let y = a.y0; y <= a.y1; y += 1) {
        for (let x = a.x0; x <= a.x1; x += 1) {
          const inA = labels[y * width + x] === a.label;
          const mx = b.x1 - (x - a.x0), my = b.y0 + (y - a.y0);
          if (my > b.y1 || mx < b.x0) continue;
          const inB = labels[my * width + mx] === b.label;
          if (inA || inB) { tot++; if (inA && inB) hit++; }
        }
      }
      if (tot && hit / tot >= 0.6) { twins.add(a); twins.add(b); }
    }
  }
  return twins;
}

/**
 * How strongly the ink of a line repeats at one spacing (0..1). Words are
 * irregular; studs, beads, scales and tiled borders repeat.
 */
function periodicity(g: Comp[], labels: Int32Array, width: number): number {
  const x0 = Math.min(...g.map((c) => c.x0)), x1 = Math.max(...g.map((c) => c.x1));
  const y0 = Math.min(...g.map((c) => c.y0)), y1 = Math.max(...g.map((c) => c.y1));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < h * 2.5) return 0;
  const ids = new Set(g.map((c) => c.label));
  const p = new Float64Array(w);
  for (let x = x0; x <= x1; x++) { let n = 0; for (let y = y0; y <= y1; y++) if (ids.has(labels[y * width + x])) n++; p[x - x0] = n; }
  const mean = p.reduce((a, b) => a + b, 0) / w;
  let e = 0;
  for (let i = 0; i < w; i++) { p[i] -= mean; e += p[i] * p[i]; }
  if (!e) return 0;
  let best = 0;
  const minLag = Math.max(2, Math.round(h * 0.25)), maxLag = Math.floor(w / 3);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < w; i++) s += p[i] * p[i + lag];
    // Normalise by the overlap so long lags aren't penalised for being short.
    const ac = (s / e) * (w / (w - lag));
    if (ac > best) best = ac;
  }
  return Math.min(1, best);
}

function scoreLine(all: Comp[], ch: Channel, mirrored: Set<Comp>, lenient: boolean, period: number): TextLine | null {
  const hs = all.map((c) => c.y1 - c.y0 + 1);
  const mh = median(hs);
  const baseAll = median(all.map((c) => c.y1));
  const tall = Math.max(...hs);
  // Members: glyphs of the line's height, plus lowercase letters standing on its baseline.
  const g = all.filter((c) => {
    const h = c.y1 - c.y0 + 1;
    return (h >= mh * 0.55 && h <= mh * 1.6) || (Math.abs(c.y1 - baseAll) <= tall * 0.15 && h >= tall * 0.38);
  });
  if (!g.length) return null;
  const uniform = g.length / all.length;
  const x0 = Math.min(...g.map((c) => c.x0)), x1 = Math.max(...g.map((c) => c.x1));
  const y0 = Math.min(...g.map((c) => c.y0)), y1 = Math.max(...g.map((c) => c.y1));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;

  // Effective glyph count: a blob wide enough for several letters, crossed
  // by many strokes, is a word whose letters touch.
  const count = g.reduce((s, c) => {
    const cw = c.x1 - c.x0 + 1, chh = c.y1 - c.y0 + 1;
    const byWidth = cw / (chh * 0.62);
    const byStrokes = c.transitions / 2.2;
    return s + Math.max(1, Math.min(byWidth, Math.max(1, byStrokes)));
  }, 0);

  const sws = g.map((c) => c.sw / (c.y1 - c.y0 + 1));
  const sw = median(sws);
  const cv = median(g.map((c) => c.cv));
  const swSpread = g.length >= 2 ? Math.max(...g.map((c) => c.sw)) / Math.max(0.5, Math.min(...g.map((c) => c.sw))) : 1;
  const bottoms = g.map((c) => c.y1);
  const base = median(bottoms);
  const aligned = g.filter((c) => Math.abs(c.y1 - base) <= Math.max(mh * 0.22, tall * 0.15)).length / g.length;
  const med = [0, 1, 2].map((k) => median(g.map((c) => c.rgb[k])));
  const sameColor = g.filter((c) => Math.abs(c.rgb[0] - med[0]) + Math.abs(c.rgb[1] - med[1]) + Math.abs(c.rgb[2] - med[2]) <= 120).length / g.length;
  const sharp = median(g.map((c) => c.sharp));
  const twins = g.filter((c) => mirrored.has(c)).length / g.length;
  let ink = 0, boxes = 0;
  for (const c of g) { ink += c.area; boxes += (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1); }
  const sorted = [...g].sort((m, n) => m.x0 - n.x0);
  let covered = 0, reach = -1;
  for (const c of sorted) { const s = Math.max(c.x0, reach + 1); if (c.x1 >= s) covered += c.x1 - s + 1; reach = Math.max(reach, c.x1); }
  const fillLine = covered / w;

  // Letters differ from each other (an M is wider than an I); a row of
  // beads, studs or diamond tiles repeats one shape.
  const cvOf = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return m ? Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) / m : 0; };
  const widths = g.map((c) => c.x1 - c.x0 + 1), heights = g.map((c) => c.y1 - c.y0 + 1), fills = g.map((c) => c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)));
  const repeated = g.length >= 4 && cvOf(widths) < 0.13 && cvOf(heights) < 0.1 && cvOf(fills) < 0.12;

  const reasons: string[] = [];
  const reject = (why: string) => { reasons.push(why); return true; };
  let bad = false;
  if (count < 1.6 && !lenient) bad = reject("one glyph");
  if (g.length === 1) {
    // One blob is a word only if a scan across it meets several strokes of one even width.
    const c = g[0];
    if (c.transitions < 3.5 || c.cv > 0.45 || c.sharp < 50 || sw < 0.07 || sw > 0.35 || count < 2.5 || w > h * 7) bad = reject("lone blob");
  }
  if (repeated) bad = reject("repeated shape");
  if (period >= 0.72) bad = reject("periodic");
  if (mh < 9 && w > mh * 12 && g.length >= 6) bad = reject("bead row");
  if (w < h * 0.9 && count < 2) bad = reject("narrow");
  if (g.length >= 3 && aligned < 0.55) bad = reject("baseline");
  if (g.length >= 3 && uniform < 0.55) bad = reject("heights");
  if (g.length >= 3 && sameColor < 0.55) bad = reject("colours");
  if (fillLine < 0.42 && g.length >= 2) bad = reject("sparse");
  if (twins >= 0.5) bad = reject("mirrored");
  if (swSpread > 3.2) bad = reject("stroke spread");
  if (bad && !lenient) return null;

  const strokeFactor = Math.min(1, Math.max(0.2, (sw - 0.05) / 0.08)) * (cv <= 0.45 ? 1 : Math.max(0.25, 1 - (cv - 0.45) * 1.6));
  const sharpFactor = Math.min(1, Math.max(0.2, (sharp - 20) / 60));
  const countFactor = count >= 3 ? 1 : count >= 2 ? 0.6 : 0.3;
  const score = Math.round(Math.pow(count, 0.7) * Math.sqrt(ink) * countFactor * strokeFactor * sharpFactor * (0.4 + 0.6 * aligned) * (0.5 + 0.5 * sameColor) * (1 - twins) * (bad ? 0.3 : 1));
  const confident = !bad && count >= 2.5 && cv <= 0.55 && sw >= 0.08 && sharp >= 40 && aligned >= 0.7 && sameColor >= 0.7;
  return {
    box: { x: x0, y: y0, width: w, height: h },
    glyphs: g.map((c) => ({ x: c.x0, y: c.y0, width: c.x1 - c.x0 + 1, height: c.y1 - c.y0 + 1 })),
    count: Math.round(count * 10) / 10,
    height: mh,
    strokeWidth: median(g.map((c) => c.sw)),
    score,
    confident,
    polarity: ch.polarity,
    threshold: ch.threshold,
    color: [Math.round(med[0]), Math.round(med[1]), Math.round(med[2])],
    debug: `n${g.length} c${count.toFixed(1)} sw${sw.toFixed(2)} cv${cv.toFixed(2)} sh${Math.round(sharp)} al${aligned.toFixed(2)} col${sameColor.toFixed(2)} fill${fillLine.toFixed(2)} tw${twins.toFixed(2)} per${period.toFixed(2)}${reasons.length ? " ✗" + reasons.join(",") : ""}`,
  };
}
