"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { MovieFile } from "@/lib/svga";
import type { TextAnalysis, TextItem } from "@/lib/text/items";
import { isEdited } from "@/lib/text/items";
import { addFontFile, fontDef, listFonts, onFontsChange, type FontDef } from "@/lib/text/fonts";
import type { TextStyle } from "@/lib/text/style";
import { Badge, Button, Checkbox, ColorInput, Section, Segmented, Slider, Toggle } from "./ui";

type Props = {
  movie: MovieFile;
  analysis: TextAnalysis | null;
  analyzing: boolean;
  reading: boolean;
  items: TextItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (it: TextItem) => void;
  onForget: (id: string) => void;
  selectMode: boolean;
  onSelectMode: (b: boolean) => void;
  onImage: (it: TextItem, file: File, circle: boolean) => void;
  onDeleteLayer: (it: TextItem) => void;
  onSeries: (values: string[]) => void;
  siblings: number;
  disabled?: boolean;
};

/** "1-20, 25" → ["1", …, "20", "25"]; plain words pass through. */
export function parseSeries(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(/[,\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (b >= a && b - a < 1000) for (let n = a; n <= b; n++) out.push(String(n));
    } else out.push(part);
  }
  return [...new Set(out)];
}

const KIND: Record<TextItem["kind"], { label: string; tone: "good" | "info" | "warn" | "bad" | "neutral"; hint: string }> = {
  slot: { label: "Text slot", tone: "info", hint: "An empty bitmap your app fills at runtime (a name, a level). Typing here bakes text into it; the app can still replace it." },
  "image-slot": { label: "Image slot", tone: "info", hint: "An empty bitmap your app fills with a picture at runtime (an avatar, a gift). Choose an image to bake one in." },
  layer: { label: "Text layer", tone: "good", hint: "The letters are their own layer: they are cleared and the new text drawn in the same look." },
  painted: { label: "On artwork", tone: "good", hint: "The letters are painted into the artwork: they are erased, the background is filled in, and the new text drawn on top." },
  hidden: { label: "Hidden", tone: "bad", hint: "This text is never shown (almost fully transparent or off the canvas) — often a seller's watermark carried inside the file." },
};

export default function TextPanel(p: Props) {
  const { analysis, analyzing, reading, items, selectedId } = p;
  const sure = items.filter((i) => i.confident || i.source !== "detected" || isEdited(i));
  // Nothing confirmed: still put the best candidates in front.
  const strong = sure.length ? sure : items.filter((i) => i.score >= 150).slice(0, 3);
  const weak = items.filter((i) => !strong.includes(i));
  const [showWeak, setShowWeak] = useState(false);
  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button tone={p.selectMode ? "primary" : "ghost"} onClick={() => p.onSelectMode(!p.selectMode)} disabled={p.disabled} className="flex-1 py-2"
          title="Drag a box around any text on the stage to edit it">
          {p.selectMode ? "Drawing a box… (Esc)" : "＋ Select text on the stage"}
        </Button>
      </div>

      <div className="text-[11px] text-white/45 leading-relaxed">
        {analyzing ? "Looking for text in every layer…"
          : !analysis ? null
          : items.length && !strong.length
            ? <>No text confirmed{reading ? " yet — reading…" : ""}. {weak.length} possible {weak.length === 1 ? "spot" : "spots"} below; or draw a box over the text on the stage.</>
          : items.length
            ? <>Found {strong.length} {strong.length === 1 ? "text" : "texts"}{weak.length ? ` and ${weak.length} possible` : ""} in {analysis.ms} ms{reading ? " · reading them…" : ""}. Click one, or draw a box over text that isn't listed.</>
            : <>No text found automatically. Draw a box around the text on the stage{p.siblings ? "" : ", or add the other files of this set (level-1 … level-50) so the difference shows where it is"}.</>}
        {analysis?.glyphsNote && <div className="mt-1 text-emerald-300/80">Lettering: {analysis.glyphsNote}.</div>}
      </div>

      <ul className="space-y-1.5">
        {strong.map((it, i) => <ItemRow key={it.id} it={it} index={i} {...p} />)}
      </ul>

      {weak.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowWeak((s) => !s)} className="text-[11px] text-white/50 hover:text-white/80">
            {showWeak ? "Hide" : "Show"} {weak.length} possible {weak.length === 1 ? "text" : "texts"} (unconfirmed)
          </button>
          {showWeak && <ul className="mt-1.5 space-y-1.5">{weak.map((it, i) => <ItemRow key={it.id} it={it} index={strong.length + i} {...p} />)}</ul>}
        </div>
      )}

      {selected && <ItemEditor key={selected.id} it={selected} {...p} />}

      <SeriesBox onSeries={p.onSeries} disabled={p.disabled || !selected || selected.kind === "image-slot"} itemName={selected ? itemTitle(selected, 0) : null} />
    </div>
  );
}

export function itemTitle(it: TextItem, index: number): string {
  if (it.kind === "slot") return `Slot “${it.layers[0].key}”`;
  if (it.kind === "image-slot") return `Image “${it.layers[0].key}”`;
  if (it.kind === "hidden") return `Hidden layer “${it.layers[0].key}”`;
  if (it.original && (it.verified || it.source === "diff")) return `“${it.original}”`;
  return `Text ${index + 1}`;
}

function ItemRow({ it, index, selectedId, onSelect, onChange, onForget, movie, disabled }: Props & { it: TextItem; index: number }) {
  const sel = it.id === selectedId;
  const kind = KIND[it.kind];
  const frames = it.layers[0].keys.length;
  return (
    <li>
      <div className={`rounded-xl border transition ${sel ? "border-brand-400/70 bg-white/[0.07]" : "border-white/10 hover:border-white/25 bg-white/[0.03]"}`}>
        <button type="button" onClick={() => onSelect(sel ? null : it.id)} className="w-full flex items-center gap-2.5 p-2 text-left">
          <Crop movie={movie} it={it} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm text-white">{itemTitle(it, index)}</span>
              {isEdited(it) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fuchsia-400" title="edited" />}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1">
              <Badge tone={kind.tone} title={kind.hint}>{kind.label}</Badge>
              {it.source === "manual" && <Badge>picked</Badge>}
              {it.source === "diff" && <Badge tone="good" title="Found by comparing the files of this set">set</Badge>}
              {!it.confident && it.source === "detected" && <Badge tone="warn" title="Looks like text but couldn't be confirmed">possible</Badge>}
              {it.layers.length > 1 && <Badge title="Shadow / highlight copies of the same text, redrawn together">{it.layers.length} layers</Badge>}
              {frames > 1 && <Badge title="The text is painted into every frame of an image sequence">{frames} frames</Badge>}
            </div>
          </div>
        </button>
        {it.kind !== "image-slot" && it.kind !== "hidden" && (
          <div className="px-2 pb-2 -mt-0.5 flex items-center gap-1.5">
            <input type="text" value={it.text} placeholder={it.original && it.verified ? `Replace “${it.original}”` : it.kind === "slot" ? "Text to bake in" : "New text"} disabled={disabled || it.remove}
              onFocus={() => !sel && onSelect(it.id)} onChange={(e) => onChange({ ...it, text: e.target.value })} maxLength={80} autoComplete="off" spellCheck={false}
              className="min-w-0 flex-1 rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50" />
            {it.source === "manual" && (
              <button type="button" onClick={() => onForget(it.id)} title="Forget this selection" className="h-7 w-7 shrink-0 rounded-lg text-white/40 hover:text-white hover:bg-white/10">×</button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

const cropCache = new Map<string, string>();

/** A thumbnail of the text: its region cut from the main bitmap. */
function Crop({ movie, it }: { movie: MovieFile; it: TextItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const L = it.layers[0];
  const sig = `${L.key}|${L.region.x},${L.region.y},${L.region.width},${L.region.height}|${movie.images[L.key]?.byteLength}`;
  useEffect(() => {
    let cancelled = false;
    const hit = cropCache.get(sig);
    if (hit) { setUrl(hit); return; }
    (async () => {
      const bytes = movie.images[L.key];
      if (!bytes) return;
      try {
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
        const r = L.region;
        const s = Math.min(112 / Math.max(1, r.width), 44 / Math.max(1, r.height), 3);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(r.width * s)); c.height = Math.max(1, Math.round(r.height * s));
        c.getContext("2d")!.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, c.width, c.height);
        bmp.close?.();
        const u = c.toDataURL();
        if (cropCache.size > 300) cropCache.clear();
        cropCache.set(sig, u);
        if (!cancelled) setUrl(u);
      } catch { /* not an image */ }
    })();
    return () => { cancelled = true; };
  }, [sig, movie, L.key, L.region]);
  return (
    <div className="h-11 w-28 shrink-0 rounded-lg checkerboard bg-black/30 grid place-items-center overflow-hidden">
      {url
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={url} alt="" className="max-h-11 max-w-28" draggable={false} />
        : <span className="text-[10px] text-white/30">{it.kind === "slot" ? "empty" : "…"}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The editor for one item                                               */
/* ------------------------------------------------------------------ */

type Preset = { id: string; label: string; swatch: string; apply: (s: TextStyle, matched: TextStyle) => TextStyle };

const PRESETS: Preset[] = [
  { id: "match", label: "Match", swatch: "conic-gradient(from 0deg, #fff, #e39b12, #5890ff, #fff)", apply: (s, m) => ({ ...s, fill: m.fill, stroke: m.stroke, shadow: m.shadow }) },
  { id: "white", label: "White", swatch: "#ffffff", apply: (s) => ({ ...s, fill: { mode: "solid", colors: ["#ffffff"] } }) },
  { id: "gold", label: "Gold", swatch: "linear-gradient(#fff6c4, #f2b630, #b86d0b)", apply: (s) => ({ ...s, fill: { mode: "gradient", colors: ["#fff6c4", "#f2b630", "#b86d0b"] }, stroke: { enabled: true, color: "#4a2200", width: 0.08 } }) },
  { id: "silver", label: "Silver", swatch: "linear-gradient(#ffffff, #c6cfdc, #7d8899)", apply: (s) => ({ ...s, fill: { mode: "gradient", colors: ["#ffffff", "#c6cfdc", "#7d8899"] }, stroke: { enabled: true, color: "#1f2633", width: 0.08 } }) },
  { id: "rose", label: "Rose", swatch: "linear-gradient(#ffe0f0, #ff6fb1)", apply: (s) => ({ ...s, fill: { mode: "gradient", colors: ["#ffe0f0", "#ff6fb1"] }, stroke: { enabled: true, color: "#5a0631", width: 0.08 } }) },
  { id: "red", label: "Red", swatch: "linear-gradient(#ff9a9a, #c1121f)", apply: (s) => ({ ...s, fill: { mode: "gradient", colors: ["#ff9a9a", "#c1121f"] }, stroke: { enabled: true, color: "#3a0007", width: 0.08 } }) },
  { id: "black", label: "Black", swatch: "#111111", apply: (s) => ({ ...s, fill: { mode: "solid", colors: ["#111111"] }, stroke: { ...s.stroke, enabled: false } }) },
];

function useFonts(): FontDef[] {
  const [fonts, setFonts] = useState(listFonts);
  useEffect(() => onFontsChange(() => setFonts(listFonts())), []);
  return fonts;
}

function ItemEditor({ it, onChange, onImage, onDeleteLayer, analysis, disabled }: Props & { it: TextItem }) {
  const s = it.style;
  const set = (next: Partial<TextStyle>) => onChange({ ...it, style: { ...s, ...next } });
  const fonts = useFonts();
  const font = fontDef(s.font);
  const fontFile = useRef<HTMLInputElement>(null);
  const imageFile = useRef<HTMLInputElement>(null);
  const [circle, setCircle] = useState(/avat|head|tou/i.test(it.layers[0].key));
  const [advanced, setAdvanced] = useState(false);
  const regionMax = Math.max(it.layers[0].region.height * 1.6, s.capHeight * 1.5, 12);
  const canSet = !!analysis?.glyphs && analysis.glyphs.key === it.layers[0].key;
  const weights = useMemo(() => [100, 200, 300, 400, 500, 600, 700, 800, 900].filter((w) => font.weights.length === 1 || font.weights.includes(w)), [font]);

  if (it.kind === "image-slot") {
    return (
      <div className="rounded-xl bg-white/5 p-3 space-y-3">
        <p className="text-[11px] text-white/50 leading-relaxed">{KIND["image-slot"].hint}</p>
        <Checkbox label="Cut to a circle" checked={circle} onChange={setCircle} disabled={disabled} />
        <input ref={imageFile} type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImage(it, f, circle); e.target.value = ""; }} />
        <Button tone="primary" onClick={() => imageFile.current?.click()} disabled={disabled} className="w-full py-2">Choose an image…</Button>
        <p className="text-[10px] text-white/35">Fitted to {it.layers[0].region.width}×{it.layers[0].region.height}, the slot&apos;s own size.</p>
      </div>
    );
  }

  if (it.kind === "hidden") {
    return (
      <div className="rounded-xl border border-red-500/25 bg-red-500/10 p-3 space-y-2">
        <p className="text-[11px] text-red-100/80 leading-relaxed">{KIND.hidden.hint}{it.original ? <> It reads: <span className="font-mono">“{it.original}”</span>.</> : null}</p>
        <div className="flex gap-2">
          <Button tone="danger" onClick={() => onDeleteLayer(it)} disabled={disabled} className="flex-1">Delete this layer</Button>
          <Button onClick={() => onChange({ ...it, remove: !it.remove, text: "" })} disabled={disabled}>{it.remove ? "Keep text" : "Erase text only"}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/10 p-3 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Checkbox label="Remove the text (write nothing)" checked={it.remove} onChange={(b) => onChange({ ...it, remove: b })} disabled={disabled} />
        <button type="button" onClick={() => onChange({ ...it, style: { ...it.matched }, offset: { x: 0, y: 0 } })} disabled={disabled} className="text-[11px] text-brand-300 hover:text-brand-200 disabled:opacity-40" title="Back to the look measured from the original lettering">
          Reset look
        </button>
      </div>

      {canSet && (
        <Section title="Lettering">
          <Segmented label="Lettering" value={it.lettering} onChange={(v) => onChange({ ...it, lettering: v })} disabled={disabled}
            options={[{ value: "set", label: "This set's digits" }, { value: "font", label: "A font" }]} />
          <p className="mt-1.5 text-[11px] text-white/45">{it.lettering === "set" ? `Pixel-exact: ${analysis!.glyphsNote}. Only those characters can be written.` : "Drawn with a font in the look below."}</p>
        </Section>
      )}

      <div className={it.lettering === "set" && canSet ? "opacity-40 pointer-events-none space-y-4" : "space-y-4"}>
        <Section title="Font" right={<button type="button" onClick={() => fontFile.current?.click()} className="text-[11px] text-brand-300 hover:text-brand-200">Upload font…</button>}>
          <input ref={fontFile} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="sr-only"
            onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; try { const d = await addFontFile(f); set({ font: d.id }); } catch { alert("That font file couldn't be read."); } }} />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <select value={s.font} onChange={(e) => set({ font: e.target.value })} disabled={disabled} aria-label="Font family"
              className="min-w-0 rounded-lg bg-black/25 border border-white/10 px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/40" style={{ fontFamily: font.family }}>
              {(["sans", "condensed", "display", "serif", "script", "system", "uploaded"] as const).map((cat) => {
                const group = fonts.filter((f) => f.category === cat);
                return group.length ? (
                  <optgroup key={cat} label={cat[0].toUpperCase() + cat.slice(1)}>
                    {group.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </optgroup>
                ) : null;
              })}
            </select>
            <select value={s.weight} onChange={(e) => set({ weight: Number(e.target.value) })} disabled={disabled} aria-label="Weight"
              className="rounded-lg bg-black/25 border border-white/10 px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/40">
              {[...new Set([...weights, s.weight])].sort((a, b) => a - b).map((w) => <option key={w} value={w}>{WEIGHT_NAMES[w] ?? w}</option>)}
            </select>
          </div>
          <div className="mt-2 flex items-center gap-3">
            {font.italic && <Checkbox label="Italic" checked={s.italic} onChange={(b) => set({ italic: b })} disabled={disabled} />}
            <div className="flex-1"><Slider label="Slant" value={s.slant} onChange={(v) => set({ slant: v })} min={-20} max={30} step={1} suffix="°" disabled={disabled} /></div>
          </div>
        </Section>

        <Section title="Size and fit">
          <Slider label="Letter height" value={Math.round(s.capHeight)} onChange={(v) => set({ capHeight: v })} min={3} max={Math.round(regionMax)} step={1} suffix=" px" disabled={disabled} />
          <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
            <span className="text-xs text-white/70">Too long</span>
            <Segmented label="When too long" value={s.fit} onChange={(v) => set({ fit: v })} disabled={disabled}
              options={[{ value: "squeeze", label: "Squeeze", title: "Narrow it a little, then shrink" }, { value: "shrink", label: "Shrink", title: "Make it smaller" }, { value: "none", label: "Overflow", title: "Keep the size" }]} />
            <span className="text-xs text-white/70">Align</span>
            <Segmented label="Align" value={s.align} onChange={(v) => set({ align: v })} disabled={disabled}
              options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} />
          </div>
          <div className="mt-2"><Slider label="Letter spacing" value={Math.round(s.letterSpacing * 100)} onChange={(v) => set({ letterSpacing: v / 100 })} min={-10} max={50} step={1} suffix="%" disabled={disabled} /></div>
        </Section>

        <Section title="Colour">
          <div className="grid grid-cols-7 gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" onClick={() => set(p.apply(s, it.matched))} disabled={disabled} title={p.id === "match" ? "The colours of the text being replaced" : p.label}
                className="flex flex-col items-center gap-1 rounded-lg p-1 hover:bg-white/5">
                <span className="h-6 w-6 rounded-full border border-white/15" style={{ background: p.swatch }} />
                <span className="text-[9px] text-white/60">{p.label}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Segmented label="Fill" value={s.fill.mode} disabled={disabled}
              onChange={(v) => set({ fill: v === "solid" ? { mode: "solid", colors: [s.fill.colors[0] ?? "#ffffff"] } : { mode: "gradient", colors: s.fill.colors.length > 1 ? s.fill.colors : [s.fill.colors[0] ?? "#ffffff", "#e39b12"] } })}
              options={[{ value: "solid", label: "Solid" }, { value: "gradient", label: "Gradient" }]} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {s.fill.colors.map((c, i) => (
              <ColorInput key={i} value={c} label={s.fill.mode === "gradient" ? `Stop ${i + 1}` : "Fill"} disabled={disabled}
                onChange={(v) => set({ fill: { ...s.fill, colors: s.fill.colors.map((x, j) => (j === i ? v : x)) } })} />
            ))}
            {s.fill.mode === "gradient" && s.fill.colors.length < 4 && (
              <button type="button" onClick={() => set({ fill: { ...s.fill, colors: [...s.fill.colors, s.fill.colors[s.fill.colors.length - 1]] } })} className="text-[11px] text-white/50 hover:text-white">+ stop</button>
            )}
            {s.fill.mode === "gradient" && s.fill.colors.length > 2 && (
              <button type="button" onClick={() => set({ fill: { ...s.fill, colors: s.fill.colors.slice(0, -1) } })} className="text-[11px] text-white/50 hover:text-white">− stop</button>
            )}
          </div>
        </Section>

        <Section title="Outline" right={<Toggle checked={s.stroke.enabled} onChange={(b) => set({ stroke: { ...s.stroke, enabled: b } })} disabled={disabled} label="Outline" />}>
          {s.stroke.enabled && (
            <div className="flex items-center gap-3">
              <ColorInput value={s.stroke.color} onChange={(v) => set({ stroke: { ...s.stroke, color: v } })} disabled={disabled} label="Outline colour" />
              <div className="flex-1"><Slider label="Width" value={Math.round(s.stroke.width * 100)} onChange={(v) => set({ stroke: { ...s.stroke, width: v / 100 } })} min={1} max={30} step={1} suffix="%" disabled={disabled} /></div>
            </div>
          )}
        </Section>

        <Section title="Shadow" right={<Toggle checked={s.shadow.enabled} onChange={(b) => set({ shadow: { ...s.shadow, enabled: b } })} disabled={disabled} label="Shadow" />}>
          {s.shadow.enabled && (
            <div className="space-y-2">
              <ColorInput value={s.shadow.color} onChange={(v) => set({ shadow: { ...s.shadow, color: v } })} disabled={disabled} label="Shadow colour" />
              <div className="grid grid-cols-3 gap-2">
                <Slider label="X" value={Math.round(s.shadow.dx * 100)} onChange={(v) => set({ shadow: { ...s.shadow, dx: v / 100 } })} min={-30} max={30} step={1} disabled={disabled} />
                <Slider label="Y" value={Math.round(s.shadow.dy * 100)} onChange={(v) => set({ shadow: { ...s.shadow, dy: v / 100 } })} min={-30} max={30} step={1} disabled={disabled} />
                <Slider label="Blur" value={Math.round(s.shadow.blur * 100)} onChange={(v) => set({ shadow: { ...s.shadow, blur: v / 100 } })} min={0} max={40} step={1} disabled={disabled} />
              </div>
            </div>
          )}
        </Section>
      </div>

      <div>
        <button type="button" onClick={() => setAdvanced((a) => !a)} className="text-[11px] text-white/50 hover:text-white/80">{advanced ? "Hide" : "Show"} position and details</button>
        {advanced && (
          <div className="mt-2 space-y-2 rounded-lg bg-black/20 p-2.5">
            <div className="grid grid-cols-2 gap-2">
              <Slider label="Move X" value={it.offset.x} onChange={(v) => onChange({ ...it, offset: { ...it.offset, x: v } })} min={-60} max={60} step={1} suffix=" px" disabled={disabled} />
              <Slider label="Move Y" value={it.offset.y} onChange={(v) => onChange({ ...it, offset: { ...it.offset, y: v } })} min={-40} max={40} step={1} suffix=" px" disabled={disabled} />
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] text-white/45 font-mono">
              <dt>bitmap</dt><dd className="truncate text-white/65">{it.layers[0].key} ({it.layers[0].erase})</dd>
              <dt>region</dt><dd className="text-white/65">{it.layers[0].region.x},{it.layers[0].region.y} {it.layers[0].region.width}×{it.layers[0].region.height}</dd>
              {it.layers.slice(1).map((l, i) => (<Fragment key={i}><dt>copy {i + 1}</dt><dd className="truncate text-white/65">{l.key} <span style={{ color: l.color }}>■</span></dd></Fragment>))}
              {it.layers[0].keys.length > 1 && (<><dt>frames</dt><dd className="text-white/65">{it.layers[0].keys.length} bitmaps of a sequence</dd></>)}
              {it.measured && (<><dt>measured</dt><dd className="text-white/65">{Math.round(it.measured.capHeight)}px · {it.measured.weight} · {it.measured.slant}° {it.measured.stroke ? `· outline ${it.measured.stroke.color}` : ""}</dd></>)}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

function SeriesBox({ onSeries, disabled, itemName }: { onSeries: (v: string[]) => void; disabled?: boolean; itemName: string | null }) {
  const [spec, setSpec] = useState("");
  const values = parseSeries(spec);
  return (
    <div className="rounded-xl bg-white/5 p-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm font-medium text-white/80">Make a series</span>
        <span className="text-[11px] text-white/40">{values.length ? `${values.length} file${values.length === 1 ? "" : "s"}` : "e.g. 1-20 or Gold, Silver"}</span>
      </div>
      <div className="flex gap-2">
        <input type="text" value={spec} onChange={(e) => setSpec(e.target.value)} disabled={disabled} placeholder="1-20" aria-label="Series values"
          className="min-w-0 flex-1 rounded-lg bg-black/25 border border-white/10 px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50" />
        <Button tone="primary" disabled={disabled || !values.length} onClick={() => onSeries(values)} className="px-3 py-2 whitespace-nowrap">Build zip</Button>
      </div>
      <p className="mt-1.5 text-[11px] text-white/40">
        {itemName ? <>One file per value, written into {itemName}, with all other edits, compression and watermark. Named after this file (level-41 → level-7).</> : "Select a text first."}
      </p>
    </div>
  );
}

