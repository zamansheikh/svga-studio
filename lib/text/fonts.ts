"use client";

import { fontFamilies } from "@/app/fonts";

/**
 * The fonts new text can be set in: a few bundled families picked to cover
 * the lettering seen on live-stream badges (heavy sans, condensed, classic
 * caps, high-contrast serif, scripts, chunky game type), the system's own
 * sans and serif, and any font file the user drops in. Every stack ends in
 * system fonts so scripts the family lacks (Arabic, Bengali, CJK…) still render.
 */

export type FontDef = {
  id: string;
  label: string;
  /** CSS font-family list. */
  family: string;
  category: "sans" | "condensed" | "serif" | "script" | "display" | "system" | "uploaded";
  /** Weights the family really has (others are synthesised). */
  weights: number[];
  italic: boolean;
};

const range = (a: number, b: number) => Array.from({ length: (b - a) / 100 + 1 }, (_, i) => a + i * 100);

const BUILT_IN: FontDef[] = [
  { id: "montserrat", label: "Montserrat", family: fontFamilies.montserrat, category: "sans", weights: range(100, 900), italic: true },
  { id: "oswald", label: "Oswald", family: fontFamilies.oswald, category: "condensed", weights: range(200, 700), italic: false },
  { id: "bebas", label: "Bebas Neue", family: fontFamilies.bebas, category: "condensed", weights: [400], italic: false },
  { id: "russo", label: "Russo One", family: fontFamilies.russo, category: "display", weights: [400], italic: false },
  { id: "luckiest", label: "Luckiest Guy", family: fontFamilies.luckiest, category: "display", weights: [400], italic: false },
  { id: "cinzel", label: "Cinzel", family: fontFamilies.cinzel, category: "serif", weights: range(400, 900), italic: false },
  { id: "playfair", label: "Playfair Display", family: fontFamilies.playfair, category: "serif", weights: range(400, 900), italic: true },
  { id: "lobster", label: "Lobster", family: fontFamilies.lobster, category: "script", weights: [400], italic: false },
  { id: "greatvibes", label: "Great Vibes", family: fontFamilies.greatvibes, category: "script", weights: [400], italic: false },
  { id: "system-sans", label: "System sans", family: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial', category: "system", weights: range(100, 900), italic: true },
  { id: "system-serif", label: "System serif", family: 'ui-serif, Georgia, "Times New Roman", Times', category: "system", weights: [400, 700], italic: true },
];

const uploaded: FontDef[] = [];
const listeners = new Set<() => void>();

export function listFonts(): FontDef[] {
  return [...BUILT_IN, ...uploaded];
}

export function onFontsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function fontDef(id: string): FontDef {
  return listFonts().find((f) => f.id === id) ?? BUILT_IN[0];
}

const FALLBACK = 'system-ui, "Noto Sans", "Noto Sans Arabic", "Noto Sans Bengali", "PingFang SC", "Microsoft YaHei", sans-serif';

export function fontStack(id: string): string {
  return `${fontDef(id).family}, ${FALLBACK}`;
}

const loaded = new Map<string, Promise<void>>();

/** Make sure the face is downloaded before a canvas draws with it. */
export function ensureFont(id: string, weight: number, italic: boolean): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return Promise.resolve();
  const k = `${id}|${weight}|${italic}`;
  let p = loaded.get(k);
  if (!p) {
    p = document.fonts.load(`${italic ? "italic " : ""}${weight} 32px ${fontDef(id).family}`, "AaÁ09").then(() => undefined, () => undefined);
    loaded.set(k, p);
  }
  return p;
}

const capCache = new Map<string, number>();

/** Cap height as a fraction of the font size (H's ascent), measured once per face. */
export function capRatio(id: string, weight: number, italic: boolean): number {
  const k = `${id}|${weight}|${italic}`;
  const hit = capCache.get(k);
  if (hit) return hit;
  let ratio = 0.72;
  try {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(8, 8) : Object.assign(document.createElement("canvas"), { width: 8, height: 8 });
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    ctx.font = `${italic ? "italic " : ""}${weight} 100px ${fontStack(id)}`;
    const m = ctx.measureText("H");
    if (m.actualBoundingBoxAscent > 10) ratio = m.actualBoundingBoxAscent / 100;
  } catch { /* keep the default */ }
  // Only cache once the face is really in (the fallback measures differently).
  if (typeof document !== "undefined" && document.fonts?.check?.(`${italic ? "italic " : ""}${weight} 32px ${fontDef(id).family}`)) capCache.set(k, ratio);
  return ratio;
}

/** Add a font file (ttf, otf, woff, woff2) for this session. */
export async function addFontFile(file: File): Promise<FontDef> {
  const base = file.name.replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, " ").trim() || "Uploaded font";
  const family = `Uploaded ${base} ${uploaded.length + 1}`;
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  const def: FontDef = { id: `upload:${family}`, label: base, family: `"${family}"`, category: "uploaded", weights: [400], italic: false };
  uploaded.push(def);
  listeners.forEach((l) => l());
  return def;
}
