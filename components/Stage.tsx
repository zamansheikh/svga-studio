"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRendererFromMovie, type Renderer } from "@/lib/renderer";
import type { MovieFile } from "@/lib/svga";
import type { WatermarkConfig } from "@/lib/watermark";
import WatermarkOverlay from "./WatermarkOverlay";
import ItemOverlay, { type OverlayBox } from "./ItemOverlay";
import type { Rect } from "@/lib/text/raster";
import type { Transform } from "@/lib/movie";

export type StageView = "original" | "edited" | "result";

type Props = {
  movies: {
    original: MovieFile;
    /** The movie with layer edits, previewed with the text edits drawn in live. */
    edited: { movie: MovieFile; override: Map<string, CanvasImageSource> } | null;
    result: MovieFile | null;
  };
  view: StageView;
  onView: (v: StageView) => void;
  /** Which overlay the inspector wants on the stage. */
  mode: "text" | "watermark" | "none";
  watermark: WatermarkConfig;
  onWatermarkChange: (w: WatermarkConfig) => void;
  overlay: {
    boxes: OverlayBox[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onRegionChange: (id: string, r: Rect) => void;
    selectMode: boolean;
    onSelectRect: (r: Rect, frame: number) => void;
  };
  highlight: { transform: Transform; width: number; height: number } | null;
  /** Ask the player to jump to a frame (nonce makes repeated requests count). */
  seek: { frame: number; nonce: number } | null;
  onFrame?: (f: number) => void;
  fileName: string;
  building: boolean;
  toolbar?: ReactNode;
};

const VIEWS: { id: StageView; label: string; hint: string }[] = [
  { id: "original", label: "Original", hint: "the file as loaded" },
  { id: "edited", label: "Edited", hint: "with your edits, before compression" },
  { id: "result", label: "Result", hint: "what you will download" },
];

export default function Stage({ movies, view, onView, mode, watermark, onWatermarkChange, overlay, highlight, seek, onFrame, fileName, building, toolbar }: Props) {
  const showEdited = view === "edited" && movies.edited;
  const movie = view === "result" ? movies.result : showEdited ? movies.edited!.movie : movies.original;
  const override = showEdited ? movies.edited!.override : undefined;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [frame, setFrame] = useState(0);
  const [total, setTotal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const lastFrame = useRef(0);
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ w: number; h: number }>({ w: 640, h: 480 });
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const holding = mode === "text" && (overlay.selectMode || !!overlay.selectedId);
  const vb = movie ? { width: movie.params.viewBoxWidth || 300, height: movie.params.viewBoxHeight || 300 } : { width: 1, height: 1 };
  // Fit the animation to the stage (up to 4× for tiny badges).
  const fitScale = Math.max(0.05, Math.min(4, (area.w - 32) / vb.width, (area.h - 32) / vb.height));

  useEffect(() => {
    if (!movie || !canvasRef.current) return;
    let cancelled = false;
    let r: Renderer | null = null;
    (async () => {
      try {
        // Small animations are shown enlarged; render at that size so they stay sharp.
        const dpr = window.devicePixelRatio || 1;
        r = await createRendererFromMovie(movie, canvasRef.current!, { options: { override }, muted, pixelRatio: Math.min(4, Math.max(1, fitScale) * dpr) });
        if (cancelled) return r.destroy();
        rendererRef.current = r;
        r.onFrame = (f) => { lastFrame.current = f; setFrame(f); onFrame?.(f); };
        setTotal(r.totalFrames);
        r.seek(Math.min(lastFrame.current, r.totalFrames - 1));
        if (!holding) { r.play(); setPlaying(true); } else setPlaying(false);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; r?.destroy(); rendererRef.current = null; };
    // The override and play state are applied below without rebuilding the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie]);

  // New edits: redraw in place.
  useEffect(() => { rendererRef.current?.setOptions({ override }); }, [override]);
  useEffect(() => { rendererRef.current?.setMuted(muted); }, [muted]);

  // Hold still while a text box is selected or being drawn.
  useEffect(() => {
    if (holding && rendererRef.current?.isPlaying()) { rendererRef.current.pause(); setPlaying(false); }
  }, [holding]);

  useEffect(() => {
    if (!seek || !rendererRef.current) return;
    rendererRef.current.pause();
    setPlaying(false);
    rendererRef.current.seek(seek.frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek?.nonce]);

  const toggle = () => {
    rendererRef.current?.toggle();
    setPlaying(rendererRef.current?.isPlaying() ?? false);
  };
  const scrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    rendererRef.current?.pause();
    setPlaying(false);
    rendererRef.current?.seek(Number(e.target.value));
  };
  const step = (d: number) => {
    const r = rendererRef.current;
    if (!r) return;
    r.pause();
    setPlaying(false);
    r.seek((r.currentFrame() + d + r.totalFrames) % r.totalFrames);
  };

  const savePng = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((b) => {
      if (!b) return;
      const url = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName.replace(/\.svga$/i, "")}_${view}_frame_${String(frame + 1).padStart(3, "0")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }, [fileName, view, frame]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "1") onView("original");
      else if (e.key === "2" && movies.edited) onView("edited");
      else if (e.key === "3" && movies.result) onView("result");
      else if (e.key === " " && !e.shiftKey) { e.preventDefault(); toggle(); }
      else if (e.key === "," ) step(-1);
      else if (e.key === ".") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movies.edited, movies.result, onView]);

  const hasAudio = !!movie?.audioBytes.length;

  return (
    <section className="glass rounded-2xl overflow-hidden flex flex-col min-h-[420px]" aria-label="Preview">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
        <div className="flex gap-1 rounded-lg bg-white/5 p-1" role="tablist" aria-label="Preview view">
          {VIEWS.map((v, i) => {
            const available = v.id === "original" || (v.id === "edited" ? !!movies.edited : !!movies.result);
            const active = view === v.id;
            return (
              <button key={v.id} role="tab" aria-selected={active} disabled={!available} onClick={() => onView(v.id)} title={`${v.hint} (${i + 1})`}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${active ? "bg-white text-[#070914] shadow" : available ? "text-white/70 hover:text-white hover:bg-white/10" : "text-white/25 cursor-not-allowed"}`}>
                {v.label}
                {v.id === "result" && building && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-400 animate-pulse" />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {movie && (
            <div className="text-[11px] font-mono text-white/50 tabular-nums hidden md:block">
              {Math.round(vb.width)}×{Math.round(vb.height)} · {movie.params.fps}fps · {total}f
            </div>
          )}
        </div>
      </div>

      <div ref={areaRef} className="relative flex-1 flex items-center justify-center p-4 checkerboard h-[min(62vh,640px)] min-h-[320px]">
        {err && <div className="text-center text-red-400 text-sm max-w-xs">{err}</div>}
        {!movie && !err && <div className="text-white/40 text-sm">Nothing to show yet</div>}
        <div className="relative max-w-full">
          <canvas ref={canvasRef} className={`${movie ? "block" : "hidden"} rounded-lg`} style={{ width: Math.round(vb.width * fitScale), height: Math.round(vb.height * fitScale) }} />
          {movie && mode === "watermark" && view !== "result" && watermark.enabled && (
            <WatermarkOverlay anchorRef={canvasRef} viewboxWidth={vb.width} viewboxHeight={vb.height} config={watermark} onChange={onWatermarkChange} currentFrame={frame} />
          )}
          {movie && view !== "result" && (mode === "text" || highlight) && (
            <ItemOverlay viewbox={vb} boxes={mode === "text" ? overlay.boxes : []} selectedId={mode === "text" ? overlay.selectedId : null} onSelect={overlay.onSelect}
              onRegionChange={overlay.onRegionChange} selectMode={mode === "text" && overlay.selectMode} onSelectRect={(r) => overlay.onSelectRect(r, frame)} highlight={highlight} />
          )}
        </div>
        {mode === "text" && overlay.selectMode && view !== "result" && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[#070914]/85 backdrop-blur px-3 py-1 text-[11px] text-white/80 whitespace-nowrap">
            Drag a box around the text you want to change · Esc to cancel
          </div>
        )}
      </div>

      {movie && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-white/5">
          <IconButton onClick={() => step(-1)} label="Previous frame (,)"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></IconButton>
          <IconButton onClick={toggle} label={playing ? "Pause (space)" : "Play (space)"} strong>
            {playing ? <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></> : <path d="M7 5v14l12-7z" />}
          </IconButton>
          <IconButton onClick={() => step(1)} label="Next frame (.)"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" /></IconButton>
          <input type="range" min={0} max={Math.max(0, total - 1)} value={frame} onChange={scrub} aria-label="Seek" className="mx-1" />
          <span className="text-[11px] font-mono text-white/60 tabular-nums w-16 text-right">{frame + 1}/{total}</span>
          {hasAudio && (
            <IconButton onClick={() => setMuted((m) => !m)} label={muted ? "Sound off — click to hear it" : "Sound on"}>
              {muted
                ? <path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3L19 9.41 17.59 8 15.17 10.41 12.76 8l-1.42 1.41L13.76 12l-2.42 2.41L12.76 15.83 15.17 13.41 17.59 15.83 19 14.41 16.59 12z" />
                : <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4zM14 3.23v2.06A7 7 0 0 1 14 18.7v2.06A9 9 0 0 0 14 3.23z" />}
            </IconButton>
          )}
          <IconButton onClick={savePng} label="Save this frame as PNG">
            <path d="M12 3a1 1 0 0 1 1 1v9.586l3.293-3.293a1 1 0 1 1 1.414 1.414l-5 5a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 13.586V4a1 1 0 0 1 1-1Z" />
            <path d="M4 17a1 1 0 0 1 1 1v2h14v-2a1 1 0 1 1 2 0v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
          </IconButton>
        </div>
      )}
    </section>
  );
}

function IconButton({ onClick, label, children, strong }: { onClick: () => void; label: string; children: ReactNode; strong?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className={`${strong ? "h-9 w-9 bg-white/15" : "h-8 w-8 bg-white/5"} shrink-0 rounded-full grid place-items-center hover:bg-white/20 transition`}>
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white">{children}</svg>
    </button>
  );
}
