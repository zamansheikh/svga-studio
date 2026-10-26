"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import Dropzone from "./Dropzone";
import FilesPanel, { type LoadedFile } from "./FilesPanel";
import Stage, { type StageView } from "./Stage";
import Inspector, { type InspectorTab } from "./Inspector";
import TextPanel from "./TextPanel";
import LayersPanel from "./LayersPanel";
import Controls from "./Controls";
import Watermark from "./Watermark";
import type { OverlayBox } from "./ItemOverlay";
import { compressMovieImages, type CompressOptions } from "@/lib/compress";
import { decodeSvga, dedupeImages, encodeSvga, paramsExtraFieldCount, stripParamsMetadata, type MovieFile } from "@/lib/svga";
import { applyWatermark, defaultWatermark, type WatermarkConfig } from "@/lib/watermark";
import { MIN_ALPHA, resolveImageKey, spritesOf } from "@/lib/renderer";
import { applyLayerEdits, emptyLayerEdits, hasLayerEdits, type LayerEdits } from "@/lib/layers";
import {
  analyzeText, applyItems, editRasters, fitImage, isEdited, isSibling, itemFromRect, readItems, withRegion,
  type SiblingFile, type TextAnalysis, type TextItem,
} from "@/lib/text/items";
import { rasterOfBytes, rasterToCanvas, type Rect } from "@/lib/text/raster";
import type { Transform } from "@/lib/movie";

type Progress = { done: number; total: number; label: string };

/**
 * The editor. Files on the left, the stage in the middle, the inspector on
 * the right. Text items come from analysing the file (and its siblings) or
 * from boxes drawn on the stage; every edit shows live in the Edited view
 * and is baked into the file on Build.
 */
type WorkspaceProps = {
  /** Files handed over from the batch tool, to open here. */
  incoming?: { files: File[]; nonce: number } | null;
  /** Hand the loaded files to the batch icon tool. */
  onMakeIcons?: (files: File[]) => void;
  /** False while another tool is shown: the player stops. */
  active?: boolean;
};

export default function Workspace({ incoming = null, onMakeIcons, active = true }: WorkspaceProps = {}) {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [activeFile, setActiveFile] = useState<File | null>(null);
  const [original, setOriginal] = useState<MovieFile | null>(null);
  const [siblings, setSiblings] = useState<SiblingFile[]>([]);

  const [layerEdits, setLayerEdits] = useState<LayerEdits>(emptyLayerEdits);
  const [analysis, setAnalysis] = useState<TextAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [reading, setReading] = useState(false);
  const [items, setItems] = useState<TextItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [override, setOverride] = useState<Map<string, CanvasImageSource> | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const [options, setOptions] = useState<CompressOptions>({ scale: 1, quality: 0.85, format: "png", colors: 0, dedupe: true, stripMetadata: false });
  const [watermark, setWatermark] = useState<WatermarkConfig>(defaultWatermark);

  const [result, setResult] = useState<{ movie: MovieFile; bytes: Uint8Array; signature: string } | null>(null);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<StageView>("original");
  const [tab, setTab] = useState<InspectorTab>("text");
  const [seek, setSeek] = useState<{ frame: number; nonce: number } | null>(null);
  const [highlight, setHighlight] = useState<{ transform: Transform; width: number; height: number } | null>(null);
  const frameRef = useRef(0);
  const touched = useRef(false);
  const jumped = useRef(false);

  /* ---------------- files ---------------- */

  const pick = useCallback((target: LoadedFile, all: LoadedFile[]) => {
    setActiveFile(target.file);
    setOriginal(target.movie);
    setSiblings(all.filter((x) => x !== target && isSibling(target.movie, x.movie)).map((x) => ({ name: x.file.name, movie: x.movie })));
    setLayerEdits(emptyLayerEdits());
    setItems([]);
    setAnalysis(null);
    setSelectedId(null);
    setSelectMode(false);
    setResult(null);
    setOverride(null);
    setEditError(null);
    setView("original");
    touched.current = false;
    jumped.current = false;
  }, []);

  const load = useCallback(async (incoming: File[], append: boolean, focus?: string): Promise<void> => {
    setError(null);
    const loaded: LoadedFile[] = [];
    let firstError: string | null = null;
    for (const f of incoming) {
      if (!/\.svga$/i.test(f.name)) continue;
      if (append && files.some((x) => x.file.name === f.name)) continue;
      try {
        loaded.push({ file: f, movie: await decodeSvga(new Uint8Array(await f.arrayBuffer())) });
      } catch (e) {
        firstError ??= `${f.name}: ${(e as Error).message}`;
      }
    }
    if (firstError) setError(firstError);
    const all = append ? [...files, ...loaded] : loaded;
    if (!all.length) { if (!firstError) setError("No readable .svga files."); return; }
    setFiles(all);
    const target = focus ? all.find((x) => x.file.name === focus) : null;
    if (target && target.file !== activeFile) pick(target, all);
    else if (!append || !activeFile) pick(all[0], all);
    else {
      const cur = all.find((x) => x.file === activeFile);
      if (cur) setSiblings(all.filter((x) => x !== cur && isSibling(cur.movie, x.movie)).map((x) => ({ name: x.file.name, movie: x.movie })));
    }
  }, [files, activeFile, pick]);

  useEffect(() => {
    // Added beside whatever is open (and opened), like picking it in the Files list.
    if (incoming?.files.length) void load(incoming.files, true, incoming.files[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  const clear = useCallback(() => {
    setFiles([]); setActiveFile(null); setOriginal(null); setSiblings([]);
    setItems([]); setAnalysis(null); setSelectedId(null); setLayerEdits(emptyLayerEdits());
    setResult(null); setProgress(null); setError(null); setView("original"); setTab("text"); setOverride(null);
  }, []);

  /* ---------------- analysis ---------------- */

  useEffect(() => {
    if (!original) return;
    let cancelled = false;
    setAnalyzing(true);
    (async () => {
      try {
        const a = await analyzeText(original, siblings, activeFile?.name ?? "");
        if (cancelled) return;
        setAnalysis(a);
        // Keep what the user picked by hand and any edits made meanwhile.
        setItems((prev) => {
          const manual = prev.filter((p) => p.source === "manual");
          return [...manual, ...a.items];
        });
        setAnalyzing(false);
        // Read the text of each item in the background (OCR loads on first use).
        setReading(true);
        const probes = a.items.map((i) => ({ ...i }));
        await readItems(probes, (it) => {
          if (cancelled) return;
          setItems((prev) => {
            const next = prev.map((p) => {
              if (p.id !== it.id) return p;
              // The look the user hasn't changed follows the matched font.
              const untouched = JSON.stringify(p.style) === JSON.stringify(p.matched);
              return { ...p, original: it.original, verified: it.verified, score: it.score, confident: it.confident, matched: it.matched, style: untouched ? it.matched : p.style };
            });
            // Re-rank by what was read, until the user starts working with the list.
            return touched.current ? next : [...next].sort((x, y) => (x.source === "manual" ? -1 : y.source === "manual" ? 1 : y.score - x.score));
          });
        });
        if (!cancelled) setReading(false);
      } catch (e) {
        if (!cancelled) { setError(`Text analysis failed: ${(e as Error).message}`); setAnalyzing(false); setReading(false); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, siblings]);

  /* ---------------- live edits ---------------- */

  const base = useMemo(() => (original ? applyLayerEdits(original, layerEdits) : null), [original, layerEdits]);
  const anyText = items.some(isEdited);
  const anyEdit = anyText || hasLayerEdits(layerEdits);

  useEffect(() => {
    if (!base || !anyText) { setOverride(null); setEditError(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const rasters = await editRasters(base, items, analysis?.glyphs ?? null);
        if (cancelled) return;
        // The player looks bitmaps up by the sprite's imageKey, which may differ from the map key.
        const map = new Map<string, CanvasImageSource>();
        const canvases = new Map<string, CanvasImageSource>();
        for (const [k, r] of rasters) canvases.set(k, rasterToCanvas(r) as CanvasImageSource);
        for (const s of spritesOf(base)) { const k = resolveImageKey(base, s.imageKey); if (k && canvases.has(k)) map.set(s.imageKey, canvases.get(k)!); }
        for (const [k, c] of canvases) if (!map.has(k)) map.set(k, c);
        setOverride(map);
        setEditError(null);
        if (!jumped.current && view === "original") { setView("edited"); jumped.current = true; }
      } catch (e) {
        if (!cancelled) setEditError((e as Error).message);
      }
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, items, analysis]);

  useEffect(() => {
    if (hasLayerEdits(layerEdits) && !jumped.current && view === "original") { setView("edited"); jumped.current = true; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerEdits]);

  /* ---------------- items ---------------- */

  const updateItem = useCallback((it: TextItem) => {
    touched.current = true;
    setItems((prev) => prev.map((p) => (p.id === it.id ? it : p)));
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (!id) return;
    touched.current = true;
    const it = items.find((i) => i.id === id);
    if (it) setSeek({ frame: it.frame, nonce: Date.now() });
  }, [items]);

  const onSelectRect = useCallback(async (rect: Rect, frame: number) => {
    if (!base) return;
    setSelectMode(false);
    try {
      const it = await itemFromRect(base, frame, rect);
      if (!it) { setEditError("Nothing drawn there on this frame — try another frame or a bigger box."); return; }
      touched.current = true;
      setItems((prev) => [it, ...prev]);
      setSelectedId(it.id);
      setEditError(null);
    } catch (e) {
      setEditError((e as Error).message);
    }
  }, [base]);

  const onRegionChange = useCallback((id: string, r: Rect) => {
    touched.current = true;
    setItems((prev) => prev.map((p) => (p.id === id ? withRegion(p, r) : p)));
  }, []);

  const onImage = useCallback(async (it: TextItem, file: File, circle: boolean) => {
    const L = it.layers[0];
    try {
      const bytes = await fitImage(file, L.region.width, L.region.height, { circle });
      setLayerEdits((e) => ({ ...e, replaced: { ...e.replaced, [L.key]: bytes } }));
    } catch {
      setError("That image couldn't be read.");
    }
  }, []);

  const onReplaceLayer = useCallback(async (key: string, file: File) => {
    const r = original ? await rasterOfBytes(original.images[key]) : null;
    if (!r) return;
    try {
      const bytes = await fitImage(file, r.width, r.height, { mode: "contain" });
      setLayerEdits((e) => ({ ...e, replaced: { ...e.replaced, [key]: bytes } }));
    } catch {
      setError("That image couldn't be read.");
    }
  }, [original]);

  const onDeleteLayer = useCallback((it: TextItem) => {
    const keys = [...new Set(it.layers.flatMap((l) => l.keys))];
    setLayerEdits((e) => ({ ...e, removed: [...new Set([...e.removed, ...keys])] }));
    setItems((prev) => prev.filter((p) => p.id !== it.id));
    setSelectedId(null);
  }, []);

  // Escape: stop drawing a box, then deselect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectMode) setSelectMode(false);
      else setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode]);

  /* ---------------- layer highlight ---------------- */

  const onHoverLayer = useCallback(async (key: string | null) => {
    if (!key || !base) { setHighlight(null); return; }
    const sprites = spritesOf(base);
    const f = frameRef.current;
    let t: Transform | null = null;
    for (const s of sprites) {
      if (resolveImageKey(base, s.imageKey) !== key) continue;
      const fr = s.frames[f]?.alpha > MIN_ALPHA ? s.frames[f] : s.frames.find((x) => x.alpha > MIN_ALPHA);
      if (fr) { t = fr.transform; break; }
    }
    const r = await rasterOfBytes(base.images[key]);
    setHighlight(t && r ? { transform: t, width: r.width, height: r.height } : null);
  }, [base]);

  /* ---------------- build ---------------- */

  const signature = useMemo(() => JSON.stringify({
    f: activeFile?.name,
    t: items.filter(isEdited).map((i) => [i.id, i.text, i.remove, i.style, i.offset, i.layers[0].region, i.lettering]),
    l: [Object.keys(layerEdits.replaced).map((k) => [k, layerEdits.replaced[k].byteLength]), layerEdits.removed, layerEdits.mutedAudio],
    o: options, w: watermark,
  }), [activeFile, items, layerEdits, options, watermark]);
  const stale = !!result && result.signature !== signature;

  const finish = useCallback(async (movie: MovieFile, report?: (p: Progress) => void) => {
    let next = await compressMovieImages(movie, options, (done, total, label) => report?.({ done, total, label }));
    if (options.dedupe) next = dedupeImages(next).movie;
    if (options.stripMetadata) next = { ...next, paramsBytes: stripParamsMetadata(next.paramsBytes).bytes };
    if (watermark.enabled) { report?.({ done: 1, total: 1, label: "Applying watermark" }); next = await applyWatermark(next, watermark); }
    return next;
  }, [options, watermark]);

  const build = useCallback(async () => {
    if (!base) return;
    setBuilding(true);
    setError(null);
    try {
      let source = base;
      if (anyText) { setProgress({ done: 0, total: 1, label: "Writing text" }); source = await applyItems(base, items, analysis?.glyphs ?? null); }
      const next = await finish(source, setProgress);
      setProgress({ done: 1, total: 1, label: "Encoding" });
      const bytes = await encodeSvga(next);
      setResult({ movie: next, bytes, signature });
      setView("result");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
      setProgress(null);
    }
  }, [base, anyText, items, analysis, finish, signature]);

  const buildSeries = useCallback(async (values: string[]) => {
    if (!base || !activeFile || !values.length || !selectedId) return;
    setBuilding(true);
    setError(null);
    const zip = new JSZip();
    const stem = activeFile.name.replace(/\.svga$/i, "");
    const nameFor = (v: string) => (/\d+(?!.*\d)/.test(stem) && /^\d+$/.test(v) ? stem.replace(/\d+(?!.*\d)/, v) : `${stem}-${v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "text"}`) + ".svga";
    try {
      for (const [i, value] of values.entries()) {
        setProgress({ done: i, total: values.length, label: `Series · ${value}` });
        const variant = items.map((it) => (it.id === selectedId ? { ...it, text: value, remove: false } : it));
        const next = await finish(await applyItems(base, variant, analysis?.glyphs ?? null));
        zip.file(nameFor(value), await encodeSvga(next));
      }
      setProgress({ done: values.length, total: values.length, label: "Zipping" });
      const blob = await zip.generateAsync({ type: "blob" });
      saveBlob(blob, `${stem.replace(/[-_ ]?\d+(?!.*\d)/, "")}-${values[0]}-${values[values.length - 1]}.zip`.replace(/[^\w.-]+/g, "-"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
      setProgress(null);
    }
  }, [base, activeFile, selectedId, items, analysis, finish]);

  const downloadName = useMemo(() => {
    if (!activeFile) return null;
    const stem = activeFile.name.replace(/\.svga$/i, "");
    const first = items.find((i) => isEdited(i) && i.text.trim());
    const tag = first ? `-${first.text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "edited"}` : anyEdit ? "-edited" : ".min";
    return `${stem}${tag}.svga`;
  }, [activeFile, items, anyEdit]);

  const download = useCallback(() => {
    if (!result || !downloadName) return;
    saveBlob(new Blob([result.bytes as BlobPart], { type: "application/octet-stream" }), downloadName);
  }, [result, downloadName]);

  /* ---------------- stage overlay ---------------- */

  const boxes: OverlayBox[] = useMemo(() => items
    .filter((it) => it.id === selectedId || it.confident || it.source !== "detected" || isEdited(it))
    .map((it, i) => {
      const L = it.layers[0];
      return {
        id: it.id,
        region: L.region,
        transform: L.transform,
        bounds: { width: Math.max(L.region.x + L.region.width, ...[0]) + 4096, height: L.region.y + L.region.height + 4096 },
        tone: it.id === selectedId ? "selected" : isEdited(it) ? "edited" : it.kind === "slot" || it.kind === "image-slot" ? "slot" : it.kind === "hidden" ? "hidden" : it.confident ? "found" : "possible",
        label: it.original ? `“${it.original}”` : it.kind === "slot" ? `slot ${L.key}` : `text ${i + 1}`,
      } as OverlayBox;
    }), [items, selectedId]);

  // Real bitmap bounds for dragging, once known.
  const [bounds, setBounds] = useState<Record<string, { width: number; height: number }>>({});
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    (async () => {
      const out: Record<string, { width: number; height: number }> = {};
      for (const it of items) { const k = it.layers[0].key; if (out[k]) continue; const r = await rasterOfBytes(base.images[k]); if (r) out[k] = { width: r.width, height: r.height }; }
      if (!cancelled) setBounds(out);
    })();
    return () => { cancelled = true; };
  }, [base, items]);
  const boxesWithBounds = useMemo(() => boxes.map((b) => {
    const it = items.find((i) => i.id === b.id);
    const k = it?.layers[0].key;
    return k && bounds[k] ? { ...b, bounds: bounds[k] } : b;
  }), [boxes, bounds, items]);

  const metadataFields = useMemo(() => (original ? paramsExtraFieldCount(original.paramsBytes) : 0), [original]);
  const siblingNames = useMemo(() => new Set(siblings.map((s) => s.name)), [siblings]);

  // Dev hook for scripted checks.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") Object.assign(window, { __studio: { items, analysis, original, base, layerEdits, result } });
  }, [items, analysis, original, base, layerEdits, result]);

  if (!original || !activeFile || !base) {
    return (
      <div className="space-y-4">
        <Dropzone onFiles={(f) => load(f, false)} />
        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}
      </div>
    );
  }

  const stageMode = tab === "text" ? "text" : tab === "watermark" ? "watermark" : "none";
  return (
    <div className="space-y-3">
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}
      {original.source && (original.source.container === "zip" || original.source.note) && (
        <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-[12px] text-sky-100/90">
          {original.source.container === "zip" ? <>This is an SVGA {original.source.version} file. It opens here as usual and downloads as SVGA 2.x, which every current player reads.</> : <>Note: {original.source.note}.</>}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_380px] items-start">
        <FilesPanel files={files} active={activeFile} siblingNames={siblingNames} onPick={(f) => pick(f, files)} onAdd={(f) => load(f, true)} onClear={clear} disabled={building}
          onMakeIcons={onMakeIcons ? () => onMakeIcons(files.map((f) => f.file)) : undefined} />

        <Stage
          movies={{ original, edited: anyEdit ? { movie: base, override: override ?? new Map() } : null, result: result?.movie ?? null }}
          view={view}
          onView={setView}
          mode={stageMode}
          watermark={watermark}
          onWatermarkChange={setWatermark}
          overlay={{ boxes: boxesWithBounds, selectedId, onSelect: select, onRegionChange, selectMode, onSelectRect }}
          highlight={tab === "layers" ? highlight : null}
          seek={seek}
          suspended={!active}
          onFrame={(f) => { frameRef.current = f; }}
          fileName={activeFile.name}
          building={building}
        />

        <Inspector
          tab={tab}
          onTab={setTab}
          active={{ text: anyText, layers: hasLayerEdits(layerEdits), watermark: watermark.enabled, compress: true }}
          panels={{
            text: (
              <div className="space-y-3">
                <TextPanel movie={base} analysis={analysis} analyzing={analyzing} reading={reading} items={items} selectedId={selectedId} onSelect={select}
                  onChange={updateItem} onForget={(id) => { setItems((p) => p.filter((x) => x.id !== id)); if (selectedId === id) setSelectedId(null); }}
                  selectMode={selectMode} onSelectMode={setSelectMode} onImage={onImage} onDeleteLayer={onDeleteLayer} onSeries={buildSeries}
                  siblings={siblings.length} disabled={building} />
                {editError && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">{editError}</div>}
              </div>
            ),
            layers: <LayersPanel movie={original} edits={layerEdits} onChange={setLayerEdits} onReplace={onReplaceLayer} onHover={onHoverLayer} disabled={building} />,
            compress: <Controls value={options} onChange={setOptions} disabled={building} metadataFields={metadataFields} bare />,
            watermark: <Watermark value={watermark} onChange={setWatermark} disabled={building} bare />,
          }}
          originalSize={activeFile.size}
          resultSize={result?.bytes.byteLength ?? null}
          stale={stale}
          building={building}
          progress={progress}
          canBuild={!building}
          onBuild={build}
          onDownload={download}
          downloadName={downloadName}
        />
      </div>
    </div>
  );
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
