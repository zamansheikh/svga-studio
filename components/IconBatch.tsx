"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { decodeSvga, type MovieFile } from "@/lib/svga";
import { releaseMovie } from "@/lib/renderer";
import { DEFAULT_ICON_OPTIONS, extensionOf, ICON_PRESETS, iconName, renderIcon, thumbnailOf, type IconOptions } from "@/lib/icons";
import { filesFromDrop, filesFromInput, saveBlob, type PickedFile } from "@/lib/files";
import { formatBytes } from "@/lib/compress";
import { Button, Checkbox, ColorInput, Section, Segmented, Slider } from "./ui";

/**
 * Batch icons: drop many .svga files (or folders), get a still image of
 * each, download them all as one zip. Settings apply to every file; any
 * single file can take a different frame. Files are decoded one at a time
 * and released, so hundreds of them fit in memory.
 */

type Item = {
  id: string;
  file: File;
  path: string;
  status: "queued" | "working" | "done" | "error";
  thumb: string | null;
  blob: Blob | null;
  width: number;
  height: number;
  frame: number;
  frames: number;
  /** A frame the user picked for this file; null = the frame setting. */
  override: number | null;
  selected: boolean;
  error: string | null;
  empty: boolean;
  /** The settings the current icon was made with. */
  sig: string;
};

type Props = {
  /** Files handed over from the editor. */
  incoming: { files: PickedFile[]; nonce: number } | null;
  /** Open one file in the editor. */
  onEdit: (file: File) => void;
  active: boolean;
};

type Naming = { template: string; keepFolders: boolean; includeSvga: boolean };

const SIZES: { value: string; label: string }[] = [
  { value: "64", label: "64" }, { value: "128", label: "128" }, { value: "256", label: "256" }, { value: "512", label: "512" }, { value: "1024", label: "1024" }, { value: "native", label: "Canvas" },
];

let idSeq = 0;

export default function IconBatch({ incoming, onEdit, active }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [options, setOptions] = useState<IconOptions>(DEFAULT_ICON_OPTIONS);
  const [preset, setPreset] = useState<string>(ICON_PRESETS[0].id);
  const [naming, setNaming] = useState<Naming>({ template: "{name}", keepFolders: true, includeSvga: false });
  const [zipping, setZipping] = useState<{ done: number; label: string } | null>(null);
  const [over, setOver] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const optSig = useMemo(() => JSON.stringify(options), [options]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const optRef = useRef({ options, optSig });
  optRef.current = { options, optSig };
  const pumping = useRef(false);

  const wantSig = (it: Item, sig = optRef.current.optSig) => `${sig}|${it.override ?? "auto"}`;

  /* ---------- adding files ---------- */

  const add = useCallback((picked: PickedFile[]) => {
    if (!picked.length) return;
    setItems((prev) => {
      const have = new Set(prev.map((p) => `${p.path}|${p.file.size}`));
      const fresh = picked.filter((p) => !have.has(`${p.path}|${p.file.size}`)).map<Item>((p) => ({
        id: `i${++idSeq}`, file: p.file, path: p.path, status: "queued", thumb: null, blob: null, width: 0, height: 0, frame: 0, frames: 0,
        override: null, selected: true, error: null, empty: false, sig: "",
      }));
      return [...prev, ...fresh];
    });
  }, []);

  useEffect(() => { if (incoming) add(incoming.files); }, [incoming, add]);

  /* ---------- rendering queue ---------- */

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (;;) {
        const next = itemsRef.current.find((it) => it.sig !== wantSig(it) && it.status !== "working");
        if (!next) break;
        const sig = wantSig(next);
        const { options: o } = optRef.current;
        setItems((prev) => prev.map((p) => (p.id === next.id ? { ...p, status: "working" } : p)));
        let movie: MovieFile | null = null;
        let patch: Partial<Item>;
        try {
          movie = await decodeSvga(new Uint8Array(await next.file.arrayBuffer()));
          const icon = await renderIcon(movie, o, next.override);
          const thumb = await thumbnailOf(icon.blob);
          patch = { status: "done", blob: icon.blob, thumb, width: icon.width, height: icon.height, frame: icon.frame, frames: icon.frames, empty: icon.empty, error: null, sig };
        } catch (e) {
          patch = { status: "error", error: (e as Error).message || "Couldn't read this file", blob: null, sig };
        } finally {
          if (movie) releaseMovie(movie);
        }
        setItems((prev) => prev.map((p) => {
          if (p.id !== next.id) return p;
          if (p.thumb && patch.thumb && p.thumb !== patch.thumb) URL.revokeObjectURL(p.thumb);
          // Settings changed while this one rendered: keep the result on screen, it re-renders next.
          return { ...p, ...patch, status: patch.status === "done" && wantSig(p) !== sig ? "queued" : patch.status! };
        }));
        // Let the page breathe between files.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      pumping.current = false;
    }
    // New work may have arrived while finishing.
    if (itemsRef.current.some((it) => it.sig !== wantSig(it) && it.status !== "working")) void pump();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void pump(); }, [items.length, optSig, pump, items]);

  // Revoke thumbnails when the component goes away.
  useEffect(() => () => { for (const it of itemsRef.current) if (it.thumb) URL.revokeObjectURL(it.thumb); }, []);

  /* ---------- actions ---------- */

  const update = (id: string, patch: Partial<Item>) => setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => setItems((prev) => { const it = prev.find((p) => p.id === id); if (it?.thumb) URL.revokeObjectURL(it.thumb); return prev.filter((p) => p.id !== id); });
  const clearAll = () => { for (const it of items) if (it.thumb) URL.revokeObjectURL(it.thumb); setItems([]); setOpenId(null); };
  const setAllSelected = (b: boolean) => setItems((prev) => prev.map((p) => ({ ...p, selected: b })));
  const setOpt = (o: Partial<IconOptions>) => { setOptions((cur) => ({ ...cur, ...o })); setPreset("custom"); };

  const done = items.filter((i) => i.status === "done" && i.blob);
  const pending = items.filter((i) => i.sig !== wantSig(i, optSig)).length;
  const failed = items.filter((i) => i.status === "error").length;
  const chosen = done.filter((i) => i.selected);
  const ext = extensionOf(options);

  const fileNameOf = useCallback((it: Item, n: number) => {
    const stem = it.file.name.replace(/\.svga$/i, "");
    return iconName(naming.template, { name: stem, n, frame: it.frame, size: `${it.width}x${it.height}` }, ext);
  }, [naming.template, ext]);

  const downloadZip = useCallback(async () => {
    if (!chosen.length) return;
    setZipping({ done: 0, label: "Packing" });
    try {
      const zip = new JSZip();
      // Zip entries carry local time; JSZip writes the UTC clock, so shift it.
      const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
      const used = new Set<string>();
      chosen.forEach((it, i) => {
        const dir = naming.keepFolders ? it.path.split("/").slice(0, -1).join("/") : "";
        let name = fileNameOf(it, i + 1);
        let full = dir ? `${dir}/${name}` : name;
        for (let k = 2; used.has(full.toLowerCase()); k++) { name = name.replace(/(\.[^.]+)$/, `-${k}$1`); full = dir ? `${dir}/${name}` : name; }
        used.add(full.toLowerCase());
        zip.file(full, it.blob!, { binary: true, date });
        if (naming.includeSvga) zip.file(dir ? `${dir}/${it.file.name}` : it.file.name, it.file, { binary: true, date });
      });
      // Images are already compressed: store them, which is much faster.
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (m) => setZipping({ done: m.percent, label: "Packing" }));
      const tops = new Set(chosen.map((i) => (i.path.includes("/") ? i.path.split("/")[0] : "")));
      const base = tops.size === 1 && [...tops][0] ? `${[...tops][0]}-icons` : `svga-icons-${chosen.length}`;
      saveBlob(blob, `${base}.zip`);
    } finally {
      setZipping(null);
    }
  }, [chosen, naming, fileNameOf]);

  /* ---------- drop handling ---------- */

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    void filesFromDrop(e.dataTransfer).then(add);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); folderInput.current?.setAttribute("directory", ""); }, []);

  const pickers = (
    <>
      <input ref={fileInput} type="file" accept=".svga" multiple className="sr-only" onChange={(e) => { add(filesFromInput(e.target.files)); e.target.value = ""; }} />
      <input ref={folderInput} type="file" multiple className="sr-only" onChange={(e) => { add(filesFromInput(e.target.files)); e.target.value = ""; }} />
    </>
  );

  // Dev hook for scripted checks.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") Object.assign(window, { __icons: { items, options, naming } });
  }, [items, options, naming]);

  if (!items.length) {
    return (
      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        className={`rounded-3xl border-2 border-dashed glass p-8 sm:p-12 text-center transition ${over ? "border-brand-400 bg-brand-500/10" : "border-white/10"}`}>
        {pickers}
        <div className="mx-auto h-14 w-14 rounded-2xl bg-gradient-to-br from-fuchsia-500 to-brand-500 grid place-items-center shadow-lg shadow-fuchsia-500/20">
          <svg viewBox="0 0 24 24" className="h-7 w-7 fill-white"><path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" /></svg>
        </div>
        <h2 className="mt-5 text-lg sm:text-xl font-semibold text-white">Make icons for many <span className="gradient-text">.svga</span> files at once</h2>
        <p className="mt-1 text-sm text-white/60">Drop files or whole folders here. Each animation becomes a still image; download them all as one zip.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button tone="primary" onClick={() => fileInput.current?.click()} className="px-4 py-2 text-sm">Choose files</Button>
          <Button onClick={() => folderInput.current?.click()} className="px-4 py-2 text-sm">Choose a folder</Button>
        </div>
        <p className="mt-4 text-xs text-white/40">Folders are searched inside too, and the zip keeps the same folders.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)] items-start" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }} onDrop={onDrop}>
      {pickers}
      <Settings options={options} setOpt={setOpt} preset={preset} setPreset={(id) => { const p = ICON_PRESETS.find((x) => x.id === id); if (p) { setOptions(p.options); setPreset(id); } }}
        naming={naming} setNaming={setNaming} ext={ext} sample={done[0] ? fileNameOf(done[0], 1) : null} />

      <section className={`order-1 lg:order-2 glass rounded-2xl min-w-0 transition ${over ? "ring-2 ring-brand-400" : ""}`} aria-label="Icons">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-2xl border-b border-white/5 bg-[#0b0e1c]/90 backdrop-blur px-3 py-2.5">
          <div className="mr-auto text-sm text-white">
            {items.length} {items.length === 1 ? "file" : "files"}
            <span className="ml-2 text-xs text-white/50">
              {pending ? `making ${items.length - pending} of ${items.length}…` : `${done.length} ready`}{failed ? ` · ${failed} failed` : ""}
            </span>
          </div>
          <Button onClick={() => fileInput.current?.click()}>+ Files</Button>
          <Button onClick={() => folderInput.current?.click()}>+ Folder</Button>
          <Button onClick={() => setAllSelected(chosen.length !== done.length)}>{chosen.length === done.length && done.length ? "Select none" : "Select all"}</Button>
          <Button onClick={clearAll} title="Remove every file from the list">Clear</Button>
          <Button tone="primary" onClick={downloadZip} disabled={!chosen.length || !!zipping} className="px-3">
            {zipping ? `Packing… ${Math.round(zipping.done)}%` : `Download ${chosen.length} ${chosen.length === 1 ? "icon" : "icons"} (.zip)`}
          </Button>
        </div>
        {pending > 0 && (
          <div className="h-1 bg-white/5"><div className="h-full bg-gradient-to-r from-brand-500 to-violet-500 transition-all" style={{ width: `${((items.length - pending) / items.length) * 100}%` }} /></div>
        )}
        <ul className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2.5 p-3">
          {items.map((it, i) => (
            <Card key={it.id} it={it} name={it.status === "done" ? fileNameOf(it, i + 1) : null} background={options.background} open={openId === it.id}
              onToggle={(b) => update(it.id, { selected: b })} onRemove={() => remove(it.id)} onEdit={() => onEdit(it.file)}
              onOpen={(b) => setOpenId(b ? it.id : null)} onFrame={(f) => update(it.id, { override: f })} options={options} active={active} />
          ))}
        </ul>
        <p className="px-4 pb-3 text-[11px] text-white/35">Drop more files or folders anywhere here to add them. Nothing is uploaded — icons are made in your browser.</p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Settings({ options: o, setOpt, preset, setPreset, naming, setNaming, ext, sample }: {
  options: IconOptions; setOpt: (o: Partial<IconOptions>) => void; preset: string; setPreset: (id: string) => void;
  naming: Naming; setNaming: (n: Naming) => void; ext: string; sample: string | null;
}) {
  const [custom, setCustom] = useState("");
  const sizeValue = o.size === "native" ? "native" : String(o.size);
  return (
    <aside className="order-2 lg:order-1 glass rounded-2xl p-4 space-y-5 lg:sticky lg:top-4" aria-label="Icon settings">
      <Section title="Start from">
        <div className="grid grid-cols-2 gap-1.5">
          {ICON_PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => setPreset(p.id)} title={p.hint}
              className={`rounded-xl px-2.5 py-2 text-left transition ${preset === p.id ? "bg-white/10 ring-1 ring-brand-400/70" : "bg-white/[0.03] hover:bg-white/[0.07]"}`}>
              <div className="text-xs font-medium text-white">{p.label}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-white/45">{p.hint}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Which frame">
        <Segmented label="Frame" value={o.frame} onChange={(v) => setOpt({ frame: v })}
          options={[{ value: "best", label: "Best", title: "The most detailed frame, picked automatically" }, { value: "start", label: "Start" }, { value: "middle", label: "Middle" }, { value: "end", label: "End" }]} />
        <p className="mt-1.5 text-[11px] text-white/40">Any file can use its own frame: the ↻ button on its card.</p>
      </Section>

      <Section title="Size">
        <Segmented label="Size" value={SIZES.some((s) => s.value === sizeValue) ? sizeValue : "custom"} onChange={(v) => setOpt({ size: v === "native" ? "native" : Number(v) })}
          options={SIZES.map((s) => ({ value: s.value, label: s.label, title: s.value === "native" ? "The animation's own canvas size" : `${s.value} px` }))} />
        <div className="mt-2 flex items-center gap-2">
          <input type="number" min={16} max={4096} placeholder="Custom px" value={custom} onChange={(e) => setCustom(e.target.value)}
            onBlur={() => { const n = Math.round(Number(custom)); if (n >= 16 && n <= 4096) setOpt({ size: n }); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="w-28 rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
          <span className="text-[11px] text-white/40">{o.size === "native" ? "own canvas size" : `${o.size} px ${o.shape === "square" ? "square" : "longest side"}`}</span>
        </div>
        <div className="mt-2">
          <Segmented label="Shape" value={o.shape} onChange={(v) => setOpt({ shape: v })}
            options={[{ value: "square", label: "Square" }, { value: "content", label: "Fit artwork", title: "Keep the artwork's own proportions" }]} />
        </div>
        <div className="mt-2.5 space-y-2.5">
          <Checkbox label="Trim empty space around the artwork" checked={o.trim} onChange={(b) => setOpt({ trim: b })} />
          <Slider label="Padding" value={Math.round(o.padding * 100)} onChange={(v) => setOpt({ padding: v / 100 })} min={0} max={30} step={1} suffix="%" />
        </div>
      </Section>

      <Section title="Background">
        <Segmented label="Background" value={o.background ? "colour" : "none"} onChange={(v) => setOpt({ background: v === "none" ? null : o.background ?? "#1b1f2e" })}
          options={[{ value: "none", label: "Transparent" }, { value: "colour", label: "Colour" }]} />
        {o.background && (
          <div className="mt-2 flex items-center gap-3">
            <ColorInput value={o.background} onChange={(v) => setOpt({ background: v })} label="Background colour" />
            <div className="flex-1"><Slider label="Rounded corners" value={Math.round(o.radius * 100)} onChange={(v) => setOpt({ radius: v / 100 })} min={0} max={50} step={1} suffix="%" /></div>
          </div>
        )}
        {o.format === "jpeg" && !o.background && <p className="mt-1.5 text-[11px] text-amber-200/80">JPEG has no transparency: a white background is used.</p>}
      </Section>

      <Section title="Format">
        <Segmented label="Format" value={o.format} onChange={(v) => setOpt({ format: v })}
          options={[{ value: "png", label: "PNG", title: "Lossless, transparent" }, { value: "webp", label: "WebP", title: "Small, transparent" }, { value: "jpeg", label: "JPEG", title: "Small, no transparency" }]} />
        {o.format !== "png" && <div className="mt-2"><Slider label="Quality" value={Math.round(o.quality * 100)} onChange={(v) => setOpt({ quality: v / 100 })} min={40} max={100} step={1} suffix="%" /></div>}
      </Section>

      <Section title="File names">
        <div className="flex items-center gap-1.5">
          <input type="text" value={naming.template} onChange={(e) => setNaming({ ...naming, template: e.target.value })} spellCheck={false}
            className="min-w-0 flex-1 rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
          <span className="text-xs font-mono text-white/50">.{ext}</span>
        </div>
        <p className="mt-1 text-[10px] text-white/40">{"{name}"} file name · {"{n}"} number · {"{size}"} · {"{frame}"}{sample ? <> — e.g. <span className="font-mono text-white/60">{sample}</span></> : null}</p>
        <div className="mt-2 space-y-1.5">
          <Checkbox label="Keep the folders in the zip" checked={naming.keepFolders} onChange={(b) => setNaming({ ...naming, keepFolders: b })} />
          <Checkbox label="Put each .svga next to its icon" checked={naming.includeSvga} onChange={(b) => setNaming({ ...naming, includeSvga: b })} />
        </div>
      </Section>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

const Card = memo(function Card({ it, name, background, open, onToggle, onRemove, onEdit, onOpen, onFrame, options, active }: {
  it: Item; name: string | null; background: string | null; open: boolean;
  onToggle: (b: boolean) => void; onRemove: () => void; onEdit: () => void; onOpen: (b: boolean) => void; onFrame: (f: number | null) => void;
  options: IconOptions; active: boolean;
}) {
  const folder = it.path.includes("/") ? it.path.split("/").slice(0, -1).join("/") : "";
  return (
    <li className={`group relative rounded-xl border transition ${it.selected && it.status === "done" ? "border-brand-400/40 bg-white/[0.05]" : "border-white/10 bg-white/[0.02]"}`}>
      <div className="relative aspect-square rounded-t-xl checkerboard overflow-hidden grid place-items-center" style={background ? { background } : undefined}>
        {it.thumb
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={it.thumb} alt="" className={`max-h-full max-w-full object-contain transition ${it.status === "working" || it.status === "queued" ? "opacity-50" : ""}`} draggable={false} />
          : it.status === "error" ? null : <span className="text-[11px] text-white/35">{it.status === "working" ? "making…" : "waiting"}</span>}
        {it.status === "error" && <span className="px-3 text-center text-[11px] text-red-300">{it.error}</span>}
        {(it.status === "working") && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-brand-400 animate-pulse" />}
        {it.status === "done" && (
          <label className="absolute left-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md bg-black/50 backdrop-blur">
            <input type="checkbox" checked={it.selected} onChange={(e) => onToggle(e.target.checked)} className="h-4 w-4 accent-brand-500" aria-label={`Include ${it.file.name}`} />
          </label>
        )}
        {it.override != null && <span className="absolute left-9 top-2 rounded-full bg-amber-400/90 px-1.5 py-0.5 text-[9px] font-semibold text-amber-950">frame {it.override + 1}</span>}
      </div>
      <div className="p-2">
        <div className="truncate text-xs text-white" title={it.path}>{it.file.name.replace(/\.svga$/i, "")}</div>
        <div className="truncate text-[10px] text-white/40" title={folder}>
          {it.status === "done" ? `${it.width}×${it.height} · frame ${it.frame + 1}/${it.frames}${it.blob ? ` · ${formatBytes(it.blob.size)}` : ""}` : folder || " "}
        </div>
        {it.empty && <div className="text-[10px] text-amber-200/80">Empty frame — pick another</div>}
        <div className="mt-1.5 flex items-center gap-0.5">
          <Mini label="Choose the frame" onClick={() => onOpen(!open)} disabled={it.status === "error"} activeState={open}>
            <path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" />
          </Mini>
          <Mini label={name ? `Download ${name}` : "Download"} onClick={() => it.blob && name && saveBlob(it.blob, name)} disabled={!it.blob}>
            <path d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19h14v2H5z" />
          </Mini>
          <Mini label="Open in the editor" onClick={onEdit}>
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
          </Mini>
          <span className="flex-1" />
          <Mini label="Remove from the list" onClick={onRemove}>
            <path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z" />
          </Mini>
        </div>
        {open && <FramePicker it={it} options={options} onFrame={(f) => { onFrame(f); onOpen(false); }} onClose={() => onOpen(false)} active={active} />}
      </div>
    </li>
  );
});

function Mini({ label, onClick, disabled, children, activeState }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; activeState?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className={`grid h-7 w-7 place-items-center rounded-lg transition disabled:opacity-30 ${activeState ? "bg-brand-500 text-white" : "bg-white/[0.06] text-white/75 hover:text-white hover:bg-white/15"}`}>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden>{children}</svg>
    </button>
  );
}

/** Scrub through one file's frames and pick the one for its icon. */
function FramePicker({ it, options, onFrame, onClose, active }: { it: Item; options: IconOptions; onFrame: (f: number | null) => void; onClose: () => void; active: boolean }) {
  const [movie, setMovie] = useState<MovieFile | null>(null);
  const [f, setF] = useState(it.override ?? it.frame);
  const [url, setUrl] = useState<string | null>(null);
  const run = useRef(0);

  useEffect(() => {
    let m: MovieFile | null = null;
    let cancelled = false;
    void it.file.arrayBuffer().then((b) => decodeSvga(new Uint8Array(b))).then((mv) => { if (cancelled) releaseMovie(mv); else { m = mv; setMovie(mv); } }).catch(() => onClose());
    return () => { cancelled = true; if (m) releaseMovie(m); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it.file]);

  useEffect(() => {
    if (!movie || !active) return;
    const my = ++run.current;
    const small: IconOptions = { ...options, size: 176, format: "webp", quality: 0.8, shape: options.shape };
    void renderIcon(movie, small, f).then((icon) => {
      if (my !== run.current) return;
      const u = URL.createObjectURL(icon.blob);
      setUrl((old) => { if (old) URL.revokeObjectURL(old); return u; });
    });
  }, [movie, f, options, active]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const total = it.frames || movie?.params.frames || 1;
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-black/30 p-2">
      <div className="aspect-square rounded-md checkerboard grid place-items-center overflow-hidden" style={options.background ? { background: options.background } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[10px] text-white/40">loading…</span>}
      </div>
      <input type="range" min={0} max={Math.max(0, total - 1)} value={f} onChange={(e) => setF(Number(e.target.value))} aria-label="Frame" />
      <div className="flex items-center justify-between text-[10px] text-white/50">
        <span>frame {f + 1} / {total}</span>
        <span className="flex gap-1">
          <button type="button" className="hover:text-white" onClick={() => setF((x) => Math.max(0, x - 1))}>‹</button>
          <button type="button" className="hover:text-white" onClick={() => setF((x) => Math.min(total - 1, x + 1))}>›</button>
        </span>
      </div>
      <div className="flex gap-1">
        <Button tone="primary" className="flex-1 px-1.5 py-1 text-[11px]" onClick={() => onFrame(f)}>Use this frame</Button>
        <Button className="px-1.5 py-1 text-[11px]" onClick={() => onFrame(null)} title="Back to the frame setting">Auto</Button>
      </div>
    </div>
  );
}
