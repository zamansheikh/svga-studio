"use client";

import { useRef, useState } from "react";
import type { Transform } from "@/lib/movie";
import type { Rect } from "@/lib/text/raster";

export type OverlayBox = {
  id: string;
  /** The region in its bitmap's pixels. */
  region: Rect;
  /** Bitmap → viewBox. */
  transform: Transform;
  /** Limits for the region (the bitmap size). */
  bounds: { width: number; height: number };
  tone: "selected" | "found" | "possible" | "slot" | "hidden" | "edited";
  label: string;
};

type Props = {
  viewbox: { width: number; height: number };
  boxes: OverlayBox[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRegionChange: (id: string, r: Rect) => void;
  /** Drawing a new selection box. */
  selectMode: boolean;
  onSelectRect: (r: Rect) => void;
  /** Outline of a layer to point out (hover in the layers list). */
  highlight: { transform: Transform; width: number; height: number } | null;
};

const TONE: Record<OverlayBox["tone"], { stroke: string; fill: string; dash?: string; chip: string }> = {
  selected: { stroke: "#60a5fa", fill: "rgba(96,165,250,0.02)", chip: "#3b82f6" },
  found: { stroke: "#34d399", fill: "rgba(52,211,153,0.02)", chip: "#059669" },
  possible: { stroke: "#fbbf24", fill: "rgba(251,191,36,0.05)", dash: "4 3", chip: "#b45309" },
  slot: { stroke: "#a78bfa", fill: "rgba(167,139,250,0.08)", dash: "2 3", chip: "#7c3aed" },
  hidden: { stroke: "#f87171", fill: "rgba(248,113,113,0.06)", dash: "4 3", chip: "#dc2626" },
  edited: { stroke: "#f0abfc", fill: "rgba(240,171,252,0.02)", chip: "#c026d3" },
};

const apply = (t: Transform, x: number, y: number) => ({ x: t.a * x + t.c * y + t.tx, y: t.b * x + t.d * y + t.ty });

function corners(t: Transform, r: Rect) {
  return [apply(t, r.x, r.y), apply(t, r.x + r.width, r.y), apply(t, r.x + r.width, r.y + r.height), apply(t, r.x, r.y + r.height)];
}

/** A viewBox delta → bitmap delta, through the inverse of the linear part. */
function toBitmapDelta(t: Transform, dx: number, dy: number) {
  const det = t.a * t.d - t.b * t.c || 1;
  return { x: (t.d * dx - t.c * dy) / det, y: (-t.b * dx + t.a * dy) / det };
}

type Drag = { id: string; mode: "move" | "nw" | "ne" | "se" | "sw"; sx: number; sy: number; start: Rect; t: Transform; bounds: { width: number; height: number } };

export default function ItemOverlay({ viewbox, boxes, selectedId, onSelect, onRegionChange, selectMode, onSelectRect, highlight }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  /** Pointer → viewBox coordinates. */
  const toView = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * viewbox.width, y: ((e.clientY - r.top) / r.height) * viewbox.height };
  };

  const clamp = (r: Rect, b: { width: number; height: number }): Rect => {
    const w = Math.max(4, Math.min(b.width, r.width)), h = Math.max(4, Math.min(b.height, r.height));
    return { x: Math.max(0, Math.min(b.width - w, r.x)), y: Math.max(0, Math.min(b.height - h, r.y)), width: w, height: h };
  };

  const start = (box: OverlayBox, mode: Drag["mode"]) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (box.id !== selectedId) { onSelect(box.id); if (mode === "move") return; }
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toView(e);
    drag.current = { id: box.id, mode, sx: p.x, sy: p.y, start: box.region, t: box.transform, bounds: box.bounds };
  };

  const move = (e: React.PointerEvent) => {
    const p = toView(e);
    if (draft) { setDraft({ ...draft, x1: p.x, y1: p.y }); return; }
    const d = drag.current;
    if (!d) return;
    const delta = toBitmapDelta(d.t, p.x - d.sx, p.y - d.sy);
    const s = d.start;
    let r: Rect;
    if (d.mode === "move") r = { ...s, x: s.x + delta.x, y: s.y + delta.y };
    else {
      let x0 = s.x, y0 = s.y, x1 = s.x + s.width, y1 = s.y + s.height;
      if (d.mode.includes("w")) x0 += delta.x; else x1 += delta.x;
      if (d.mode.includes("n")) y0 += delta.y; else y1 += delta.y;
      r = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }
    onRegionChange(d.id, clamp({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, d.bounds));
  };

  const end = () => {
    if (draft) {
      const r = { x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), width: Math.abs(draft.x1 - draft.x0), height: Math.abs(draft.y1 - draft.y0) };
      setDraft(null);
      if (r.width >= 3 && r.height >= 3) onSelectRect(r);
    }
    drag.current = null;
  };

  const backgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (selectMode) {
      (e.target as Element).setPointerCapture(e.pointerId);
      const p = toView(e);
      setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    } else onSelect(null);
  };

  // Stroke widths in screen pixels whatever the zoom.
  const ns = { vectorEffect: "non-scaling-stroke" as const };
  const sel = boxes.find((b) => b.id === selectedId) ?? null;

  return (
    <svg ref={svgRef} className={`absolute inset-0 h-full w-full ${selectMode ? "cursor-crosshair" : ""}`} viewBox={`0 0 ${viewbox.width} ${viewbox.height}`} preserveAspectRatio="none"
      onPointerDown={backgroundDown} onPointerMove={move} onPointerUp={end} onPointerCancel={end} style={{ touchAction: "none" }}>
      {highlight && (
        <polygon points={corners(highlight.transform, { x: 0, y: 0, width: highlight.width, height: highlight.height }).map((p) => `${p.x},${p.y}`).join(" ")}
          fill="rgba(56,189,248,0.12)" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="5 3" style={ns} pointerEvents="none" />
      )}
      {boxes.filter((b) => b.id !== selectedId).map((b) => {
        const tone = TONE[b.tone];
        const pts = corners(b.transform, b.region);
        return (
          <g key={b.id} onPointerDown={start(b, "move")} className="cursor-pointer">
            <title>{b.label}</title>
            <polygon points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill={tone.fill} stroke={tone.stroke} strokeWidth={1.25} strokeDasharray={tone.dash} style={ns} />
          </g>
        );
      })}
      {sel && (() => {
        const tone = TONE.selected;
        const pts = corners(sel.transform, sel.region);
        const handles: [Drag["mode"], { x: number; y: number }][] = [["nw", pts[0]], ["ne", pts[1]], ["se", pts[2]], ["sw", pts[3]]];
        const hs = Math.max(viewbox.width, viewbox.height) / 70;
        return (
          <g>
            <polygon points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill={tone.fill} stroke={tone.stroke} strokeWidth={2} style={ns} className="cursor-move" onPointerDown={start(sel, "move")} />
            {handles.map(([mode, p]) => (
              <rect key={mode} x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} rx={hs / 5} fill="#fff" stroke={tone.stroke} strokeWidth={1.5} style={ns}
                className={mode === "nw" || mode === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize"} onPointerDown={start(sel, mode)} />
            ))}
          </g>
        );
      })()}
      {draft && (
        <rect x={Math.min(draft.x0, draft.x1)} y={Math.min(draft.y0, draft.y1)} width={Math.abs(draft.x1 - draft.x0)} height={Math.abs(draft.y1 - draft.y0)}
          fill="rgba(96,165,250,0.12)" stroke="#60a5fa" strokeWidth={1.5} strokeDasharray="5 3" style={ns} pointerEvents="none" />
      )}
    </svg>
  );
}
