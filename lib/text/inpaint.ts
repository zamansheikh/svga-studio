import { clampRect, type Raster, type Rect } from "./raster";

/**
 * Erasing text.
 *
 * Only the letters are replaced, not the box around them: the box keeps its
 * ribbon texture, its sparkles, its border. Which pixels are "letters" is
 * decided against the background just outside the box — a pixel inside
 * that looks like nothing found on that ring is part of the text (its fill,
 * outline, glow or shadow). Those pixels are then filled from the
 * surrounding background with a multi-scale (push–pull) fill, smoothed so
 * gradients carry straight through where the letters were.
 */

export type Mask = { data: Uint8Array; width: number; height: number; x: number; y: number };

/** Premultiplied RGBA of pixel i (alpha weighted so transparent pixels have no colour). */
function pm(d: Uint8ClampedArray, i: number): [number, number, number, number] {
  const a = d[i + 3] / 255;
  return [d[i] * a, d[i + 1] * a, d[i + 2] * a, d[i + 3]];
}

/**
 * Pixels inside `region` that differ from the background ring around it.
 * `hint` (glyph pixels already known, in raster coordinates) is always included.
 */
export function textFootprint(r: Raster, region: Rect, opts: { ring?: number; threshold?: number; hint?: Mask | null; grow?: number; textColors?: number[][]; near?: { mask: Mask; radius: number } | null } = {}): Mask {
  const box = clampRect(region, r.width, r.height);
  const { data, width, height } = r;
  const ring = opts.ring ?? 3;
  const thr = opts.threshold ?? 48;
  const out = new Uint8Array(box.width * box.height);
  if (box.width < 1 || box.height < 1) return { data: out, width: box.width, height: box.height, x: box.x, y: box.y };

  // Background samples: a band just outside the box (or its inner edge where
  // the box touches the bitmap border).
  const samples: number[][] = [];
  const push = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < width && y < height) samples.push(pm(data, (y * width + x) * 4)); };
  const step = Math.max(1, Math.floor((box.width + box.height) / 160));
  for (let k = 1; k <= ring; k++) {
    for (let x = box.x - k; x < box.x + box.width + k; x += step) { push(x, box.y - k); push(x, box.y + box.height - 1 + k); }
    for (let y = box.y - k; y < box.y + box.height + k; y += step) { push(box.x - k, y); push(box.x + box.width - 1 + k, y); }
  }
  if (samples.length < 8) {
    for (let x = box.x; x < box.x + box.width; x += step) { push(x, box.y); push(x, box.y + box.height - 1); }
    for (let y = box.y; y < box.y + box.height; y += step) { push(box.x, y); push(box.x + box.width - 1, y); }
  }
  // A ring that clips a letter would teach the text's own colour as
  // "background"; drop samples that match the known text colours.
  const tc = opts.textColors ?? [];
  const clean = tc.length ? samples.filter((s) => s[3] < 128 || !tc.some((c) => Math.abs(s[0] - c[0]) + Math.abs(s[1] - c[1]) + Math.abs(s[2] - c[2]) < 60)) : samples;
  const bg = reduceSamples(clean.length >= 8 ? clean : samples, 96);

  // Within the box, distance from each pixel to the nearest background colour.
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const p = pm(data, ((y + box.y) * width + x + box.x) * 4);
      let best = Infinity;
      for (const s of bg) {
        const d = Math.abs(p[0] - s[0]) + Math.abs(p[1] - s[1]) + Math.abs(p[2] - s[2]) + Math.abs(p[3] - s[3]) * 0.75;
        if (d < best) { best = d; if (d <= thr) break; }
      }
      if (best > thr) out[y * box.width + x] = 1;
    }
  }
  const m: Mask = { data: out, width: box.width, height: box.height, x: box.x, y: box.y };
  // Outline, glow and shadow hug the letters: away from known letters,
  // whatever differs from the ring is the artwork's own shading, not text.
  if (opts.near && maskCount(opts.near.mask)) {
    const zone = dilateMask(opts.near.mask, opts.near.radius);
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      const i = y * m.width + x;
      if (!out[i]) continue;
      const zx = x + m.x - zone.x, zy = y + m.y - zone.y;
      if (zx < 0 || zy < 0 || zx >= zone.width || zy >= zone.height || !zone.data[zy * zone.width + zx]) out[i] = 0;
    }
  }
  if (opts.hint) orMask(m, opts.hint);
  despeckle(m, 3);
  // The letters' anti-aliased rim blends into the background; take a pixel more.
  return dilateMask(m, opts.grow ?? 1);
}

/** Pick a spread-out subset of colours (farthest-point sampling). */
function reduceSamples(s: number[][], max: number): number[][] {
  if (s.length <= max) return s;
  const out = [s[0]];
  const dist = s.map((p) => Math.abs(p[0] - s[0][0]) + Math.abs(p[1] - s[0][1]) + Math.abs(p[2] - s[0][2]) + Math.abs(p[3] - s[0][3]));
  while (out.length < max) {
    let bi = 0;
    for (let i = 1; i < s.length; i++) if (dist[i] > dist[bi]) bi = i;
    if (dist[bi] <= 6) break;
    const q = s[bi];
    out.push(q);
    for (let i = 0; i < s.length; i++) { const d = Math.abs(s[i][0] - q[0]) + Math.abs(s[i][1] - q[1]) + Math.abs(s[i][2] - q[2]) + Math.abs(s[i][3] - q[3]); if (d < dist[i]) dist[i] = d; }
  }
  return out;
}

export function orMask(m: Mask, other: Mask) {
  for (let y = 0; y < other.height; y++) {
    const yy = y + other.y - m.y;
    if (yy < 0 || yy >= m.height) continue;
    for (let x = 0; x < other.width; x++) {
      if (!other.data[y * other.width + x]) continue;
      const xx = x + other.x - m.x;
      if (xx >= 0 && xx < m.width) m.data[yy * m.width + xx] = 1;
    }
  }
}

/** Drop connected specks smaller than `min` pixels (noise, not letters). */
function despeckle(m: Mask, min: number) {
  const { data, width, height } = m;
  const seen = new Uint8Array(data.length);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < data.length; s++) {
    if (!data[s] || seen[s]) continue;
    comp.length = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % width, y = (i - x) / width;
      if (x > 0 && data[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < width - 1 && data[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && data[i - width] && !seen[i - width]) { seen[i - width] = 1; stack.push(i - width); }
      if (y < height - 1 && data[i + width] && !seen[i + width]) { seen[i + width] = 1; stack.push(i + width); }
    }
    if (comp.length < min) for (const i of comp) data[i] = 0;
  }
}

export function dilateMask(m: Mask, r: number): Mask {
  if (r <= 0) return m;
  const { data, width, height } = m;
  let cur = data;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (cur[y * width + x]) continue;
      if ((x > 0 && cur[y * width + x - 1]) || (x < width - 1 && cur[y * width + x + 1]) || (y > 0 && cur[(y - 1) * width + x]) || (y < height - 1 && cur[(y + 1) * width + x])) next[y * width + x] = 1;
    }
    cur = next;
  }
  return { ...m, data: cur };
}

export function maskCount(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

/**
 * Fill the masked pixels of `r` from their surroundings (in place).
 *
 * Push–pull: known pixels are averaged down a pyramid until every cell has
 * a value, then pulled back up so each hole takes the colour of what is
 * around it at the right scale; a few relaxation passes smooth the seams.
 * Works in premultiplied space so transparent surroundings fade the fill
 * out instead of painting black.
 */
export function inpaint(r: Raster, m: Mask, opts: { margin?: number; iterations?: number } = {}) {
  const margin = opts.margin ?? Math.max(4, Math.round(Math.max(m.width, m.height) * 0.25));
  const box = clampRect({ x: m.x - margin, y: m.y - margin, width: m.width + margin * 2, height: m.height + margin * 2 }, r.width, r.height);
  const W = box.width, H = box.height;
  if (!W || !H) return;
  const known = new Uint8Array(W * H);
  const val = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = x + box.x, gy = y + box.y;
    const mx = gx - m.x, my = gy - m.y;
    const hole = mx >= 0 && my >= 0 && mx < m.width && my < m.height && m.data[my * m.width + mx];
    const i = y * W + x;
    if (!hole) {
      known[i] = 1;
      const p = pm(r.data, (gy * r.width + gx) * 4);
      val[i * 4] = p[0]; val[i * 4 + 1] = p[1]; val[i * 4 + 2] = p[2]; val[i * 4 + 3] = p[3];
    }
  }

  // Pyramid of (sum, weight).
  type Level = { w: number; h: number; v: Float32Array; k: Float32Array };
  const levels: Level[] = [{ w: W, h: H, v: val, k: Float32Array.from(known) }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const p = levels[levels.length - 1];
    const w = Math.max(1, Math.ceil(p.w / 2)), h = Math.max(1, Math.ceil(p.h / 2));
    const v = new Float32Array(w * h * 4), k = new Float32Array(w * h);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const i = y * p.w + x, wgt = p.k[i];
      if (!wgt) continue;
      const j = (y >> 1) * w + (x >> 1);
      k[j] += wgt;
      for (let c = 0; c < 4; c++) v[j * 4 + c] += p.v[i * 4 + c] * wgt;
    }
    for (let j = 0; j < w * h; j++) if (k[j]) { for (let c = 0; c < 4; c++) v[j * 4 + c] /= k[j]; k[j] = Math.min(1, k[j]); }
    levels.push({ w, h, v, k });
    if (levels.length > 24) break;
  }
  // Pull: fill unknowns from the coarser level (bilinear).
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x;
      if (f.k[i] >= 1) continue;
      const cx = Math.min(c.w - 1, Math.max(0, (x - 0.5) / 2)), cy = Math.min(c.h - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1);
      const fx = cx - x0, fy = cy - y0;
      const wsum = f.k[i];
      for (let ch = 0; ch < 4; ch++) {
        const up = (c.v[(y0 * c.w + x0) * 4 + ch] * (1 - fx) + c.v[(y0 * c.w + x1) * 4 + ch] * fx) * (1 - fy) + (c.v[(y1 * c.w + x0) * 4 + ch] * (1 - fx) + c.v[(y1 * c.w + x1) * 4 + ch] * fx) * fy;
        f.v[i * 4 + ch] = f.v[i * 4 + ch] * wsum + up * (1 - wsum);
      }
      f.k[i] = 1;
    }
  }
  // Directional fill: from each hole pixel, look out in eight directions to
  // the nearest real pixel and blend them by inverse squared distance. This
  // carries gradients through the hole in every direction (a tube lit from
  // above stays lit from above), where a pyramid average would flatten it.
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  const fill = new Float32Array(W * H * 4);
  const filled = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (known[i]) continue;
    let ws = 0, hits = 0;
    const acc = [0, 0, 0, 0];
    for (const [dx, dy] of dirs) {
      let xx = x + dx, yy = y + dy, d = 1;
      while (xx >= 0 && yy >= 0 && xx < W && yy < H && !known[yy * W + xx]) { xx += dx; yy += dy; d++; }
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx, dist = d * (dx && dy ? 1.414 : 1), wgt = 1 / (dist * dist);
      for (let c = 0; c < 4; c++) acc[c] += val[j * 4 + c] * wgt;
      ws += wgt; hits++;
    }
    if (hits >= 2) { for (let c = 0; c < 4; c++) fill[i * 4 + c] = acc[c] / ws; filled[i] = 1; }
  }
  for (let i = 0; i < W * H; i++) if (filled[i]) for (let c = 0; c < 4; c++) val[i * 4 + c] = fill[i * 4 + c];

  // A few relaxation passes smooth the seams between rays.
  const iters = opts.iterations ?? 6;
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (known[i]) continue;
      let n = 0;
      const acc = [0, 0, 0, 0];
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0) continue;
        n++;
        for (let c = 0; c < 4; c++) acc[c] += val[j * 4 + c];
      }
      if (n) for (let c = 0; c < 4; c++) val[i * 4 + c] = acc[c] / n;
    }
  }
  // Write back, un-premultiplied.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (known[i]) continue;
    const o = ((y + box.y) * r.width + x + box.x) * 4;
    const a = Math.max(0, Math.min(255, val[i * 4 + 3]));
    const un = a > 0.5 ? 255 / a : 0;
    r.data[o] = Math.min(255, val[i * 4] * un);
    r.data[o + 1] = Math.min(255, val[i * 4 + 1] * un);
    r.data[o + 2] = Math.min(255, val[i * 4 + 2] * un);
    r.data[o + 3] = a;
  }
}

/** The same mask on a bigger frame (pixels outside the old frame start empty). */
export function expandMask(m: Mask, frame: Rect): Mask {
  const out: Mask = { data: new Uint8Array(frame.width * frame.height), width: frame.width, height: frame.height, x: frame.x, y: frame.y };
  orMask(out, m);
  return out;
}

/**
 * Grow a text mask to the effects around the letters — drop shadow,
 * outline, glow, the dot of an i — by comparing the image with an estimate
 * of what it looks like without the letters (the letters filled in from
 * their surroundings). Near the letters, whatever differs from that local
 * estimate belongs to the text. Unlike a colour test against the box's
 * border, this works when the border runs through gilt edges and dark
 * shading that look like the text's own colours.
 */
export function refineFootprint(r: Raster, base: Mask, zoneRadius: number, threshold = 70): Mask {
  if (!maskCount(base)) return base;
  // Estimate the background from a little beyond the letters — past a
  // typical drop shadow, short of the plate's border — so the shadow
  // doesn't count as background itself.
  const zone = dilateMask(base, zoneRadius);
  const est = { data: new Uint8ClampedArray(r.data), width: r.width, height: r.height };
  inpaint(est, dilateMask(base, Math.max(1, Math.round(zoneRadius * 0.4))));
  const out: Mask = { ...base, data: new Uint8Array(base.data) };
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const i = y * out.width + x;
    if (out.data[i] || !zone.data[i]) continue;
    const gx = x + out.x, gy = y + out.y;
    if (gx < 0 || gy < 0 || gx >= r.width || gy >= r.height) continue;
    const o = (gy * r.width + gx) * 4;
    const a = pm(r.data, o), b = pm(est.data, o);
    const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]) * 0.75;
    if (d > threshold) out.data[i] = 1;
  }
  despeckle(out, 3);
  return dilateMask(out, 1);
}

/** Clear the masked pixels to transparent (text on its own layer). */
export function clearMask(r: Raster, m: Mask) {
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (!m.data[y * m.width + x]) continue;
    const gx = x + m.x, gy = y + m.y;
    if (gx < 0 || gy < 0 || gx >= r.width || gy >= r.height) continue;
    const o = (gy * r.width + gx) * 4;
    r.data[o] = r.data[o + 1] = r.data[o + 2] = r.data[o + 3] = 0;
  }
}

/** The main colours of the masked pixels (opaque only), as RGB. */
export function maskPalette(r: Raster, m: Mask, minShare = 0.04): number[][] {
  const bins = new Map<number, { n: number; s: [number, number, number] }>();
  let total = 0;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (!m.data[y * m.width + x]) continue;
    const gx = x + m.x, gy = y + m.y;
    if (gx < 0 || gy < 0 || gx >= r.width || gy >= r.height) continue;
    const o = (gy * r.width + gx) * 4;
    if (r.data[o + 3] < 160) continue;
    const key = ((r.data[o] >> 4) << 8) | ((r.data[o + 1] >> 4) << 4) | (r.data[o + 2] >> 4);
    let b = bins.get(key);
    if (!b) bins.set(key, (b = { n: 0, s: [0, 0, 0] }));
    b.n++; b.s[0] += r.data[o]; b.s[1] += r.data[o + 1]; b.s[2] += r.data[o + 2];
    total++;
  }
  return [...bins.values()].filter((b) => b.n >= total * minShare).sort((a, b) => b.n - a.n).slice(0, 8).map((b) => [b.s[0] / b.n, b.s[1] / b.n, b.s[2] / b.n]);
}

/** Share of the masked pixels whose colour is close to `palette` (how present the text is). */
export function paletteMatch(r: Raster, m: Mask, palette: number[][], tol = 70): number {
  if (!palette.length) return 1;
  let n = 0, hit = 0;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (!m.data[y * m.width + x]) continue;
    const gx = x + m.x, gy = y + m.y;
    if (gx < 0 || gy < 0 || gx >= r.width || gy >= r.height) continue;
    const o = (gy * r.width + gx) * 4;
    n++;
    if (r.data[o + 3] < 128) continue;
    if (palette.some((c) => Math.abs(r.data[o] - c[0]) + Math.abs(r.data[o + 1] - c[1]) + Math.abs(r.data[o + 2] - c[2]) <= tol)) hit++;
  }
  return n ? hit / n : 0;
}

/** Mask of pixels with alpha above `threshold` inside `region`. */
export function alphaMask(r: Raster, region: Rect, threshold = 4): Mask {
  const box = clampRect(region, r.width, r.height);
  const data = new Uint8Array(box.width * box.height);
  for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) if (r.data[((y + box.y) * r.width + x + box.x) * 4 + 3] > threshold) data[y * box.width + x] = 1;
  return { data, width: box.width, height: box.height, x: box.x, y: box.y };
}
