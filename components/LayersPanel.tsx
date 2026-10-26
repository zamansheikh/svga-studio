"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MovieFile } from "@/lib/svga";
import { sniffImageMime } from "@/lib/svga";
import { audiosOf, MIN_ALPHA, resolveImageKey, spritesOf } from "@/lib/renderer";
import type { LayerEdits } from "@/lib/layers";
import { formatBytes } from "@/lib/compress";
import { Badge, Button } from "./ui";

type Props = {
  movie: MovieFile;
  edits: LayerEdits;
  onChange: (e: LayerEdits) => void;
  onReplace: (key: string, file: File) => void;
  onHover: (key: string | null) => void;
  disabled?: boolean;
};

type Info = {
  key: string;
  width: number;
  height: number;
  bytes: number;
  frames: number;
  sprites: number;
  alphaMax: number;
  empty: boolean;
  /** Members of the same frame sequence (this one first), when part of one. */
  sequence: string[] | null;
};

/**
 * Every bitmap in the file, with where it is used. Frame sequences fold
 * into one row. Each bitmap can be replaced (fitted to its own size),
 * saved as PNG, or deleted together with the sprites that draw it.
 */
export default function LayersPanel({ movie, edits, onChange, onReplace, onHover, disabled }: Props) {
  const [infos, setInfos] = useState<Info[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const total = Math.max(1, movie.params.frames);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sprites = spritesOf(movie);
      const use = new Map<string, { frames: Set<number>; sprites: number; alpha: number }>();
      for (const s of sprites) {
        const k = resolveImageKey(movie, s.imageKey);
        if (!k) continue;
        let u = use.get(k);
        if (!u) use.set(k, (u = { frames: new Set(), sprites: 0, alpha: 0 }));
        u.sprites++;
        s.frames.forEach((f, i) => { if (f.alpha > MIN_ALPHA) { u!.frames.add(i); u!.alpha = Math.max(u!.alpha, f.alpha); } });
      }
      const list: Info[] = [];
      for (const [key, bytes] of Object.entries(movie.images)) {
        if (sniffImageMime(bytes) === "application/octet-stream") continue;
        let width = 0, height = 0, empty = false;
        try {
          const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
          width = bmp.width; height = bmp.height;
          const c = new OffscreenCanvas(Math.min(64, width), Math.min(64, height));
          const ctx = c.getContext("2d")!;
          ctx.drawImage(bmp, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          empty = true;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 6) { empty = false; break; }
          bmp.close?.();
        } catch { /* unreadable */ }
        const u = use.get(key);
        list.push({ key, width, height, bytes: bytes.byteLength, frames: u?.frames.size ?? 0, sprites: u?.sprites ?? 0, alphaMax: u?.alpha ?? 0, empty, sequence: null });
      }
      // Sequences: ≥3 same-size bitmaps, each on few frames.
      const bySize = new Map<string, Info[]>();
      for (const i of list) if (i.frames > 0 && i.frames <= Math.max(2, total * 0.25)) { const k = `${i.width}x${i.height}`; (bySize.get(k) ?? bySize.set(k, []).get(k)!).push(i); }
      for (const g of bySize.values()) if (g.length >= 3) for (const i of g) i.sequence = g.map((x) => x.key);
      if (!cancelled) setInfos(list);
    })();
    return () => { cancelled = true; };
  }, [movie, total]);

  const rows = useMemo(() => {
    if (!infos) return [];
    const seen = new Set<string>();
    const out: { head: Info; members: Info[] }[] = [];
    for (const i of infos) {
      if (seen.has(i.key)) continue;
      if (i.sequence) {
        const members = infos.filter((x) => i.sequence!.includes(x.key));
        members.forEach((m) => seen.add(m.key));
        out.push({ head: i, members });
      } else { seen.add(i.key); out.push({ head: i, members: [i] }); }
    }
    const q = filter.trim().toLowerCase();
    return q ? out.filter((r) => r.members.some((m) => m.key.toLowerCase().includes(q))) : out;
  }, [infos, filter]);

  const audios = useMemo(() => audiosOf(movie), [movie]);
  const removed = new Set(edits.removed);
  const toggleRemove = (keys: string[]) => {
    const all = keys.every((k) => removed.has(k));
    onChange({ ...edits, removed: all ? edits.removed.filter((k) => !keys.includes(k)) : [...new Set([...edits.removed, ...keys])] });
  };

  if (!infos) return <div className="text-[11px] text-white/45">Reading layers…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${infos.length} images`}
          className="min-w-0 flex-1 rounded-lg bg-black/25 border border-white/10 px-2.5 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
      </div>
      <ul className="space-y-1" onMouseLeave={() => onHover(null)}>
        {rows.map(({ head, members }) => {
          const seq = members.length > 1;
          const keys = members.map((m) => m.key);
          const gone = keys.every((k) => removed.has(k));
          const replaced = keys.some((k) => edits.replaced[k]);
          const frames = Math.min(total, members.reduce((n, m) => n + m.frames, 0));
          const hidden = members.every((m) => m.frames === 0 || m.alphaMax < 0.05);
          const isOpen = open.has(head.key);
          return (
            <li key={head.key} onMouseEnter={() => onHover(head.key)}
              className={`rounded-xl border px-2 py-1.5 ${gone ? "border-red-500/20 bg-red-500/5 opacity-60" : "border-white/10 bg-white/[0.03]"}`}>
              <div className="flex items-center gap-2">
                <Thumb bytes={edits.replaced[head.key] ?? movie.images[head.key]} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-white font-mono" title={keys.join(", ")}>{seq ? `${head.key} … (${members.length})` : head.key}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-white/45">
                    <span>{head.width}×{head.height}</span>
                    <span>· {formatBytes(members.reduce((n, m) => n + m.bytes, 0))}</span>
                    <span>· {frames ? `${frames}/${total}f` : "never shown"}</span>
                    {seq && <Badge>sequence</Badge>}
                    {head.empty && <Badge tone="info">empty</Badge>}
                    {hidden && frames > 0 && <Badge tone="bad" title="Under 5% opacity — invisible">hidden</Badge>}
                    {replaced && <Badge tone="good">replaced</Badge>}
                  </div>
                </div>
                <RowActions disabled={disabled} gone={gone} seq={seq}
                  onReplace={(f) => onReplace(head.key, f)} onDownload={() => download(edits.replaced[head.key] ?? movie.images[head.key], `${head.key}.png`)}
                  onToggle={() => toggleRemove(keys)} onRestore={replaced ? () => { const r = { ...edits.replaced }; keys.forEach((k) => delete r[k]); onChange({ ...edits, replaced: r }); } : undefined}
                  onExpand={seq ? () => setOpen((o) => { const n = new Set(o); if (n.has(head.key)) n.delete(head.key); else n.add(head.key); return n; }) : undefined} open={isOpen} />
              </div>
              {seq && isOpen && (
                <div className="mt-1.5 grid grid-cols-6 gap-1">
                  {members.map((m) => (
                    <button key={m.key} type="button" title={`${m.key} · frames ${m.frames}`} onMouseEnter={() => onHover(m.key)} onClick={() => download(movie.images[m.key], `${m.key}.png`)}
                      className="rounded-md checkerboard bg-black/30 p-0.5"><Thumb bytes={movie.images[m.key]} small /></button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {audios.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-white/45 mb-1.5">Sound</div>
          <ul className="space-y-1">
            {audios.map((a, i) => {
              const muted = edits.mutedAudio.includes(a.audioKey);
              return (
                <li key={`${a.audioKey}-${i}`} className={`flex items-center gap-2 rounded-xl border border-white/10 px-2.5 py-1.5 ${muted ? "opacity-50" : ""}`}>
                  <span className="text-base">♪</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-mono text-white">{a.audioKey}</div>
                    <div className="text-[10px] text-white/45">frames {a.startFrame}–{a.endFrame || total} · {formatBytes(movie.images[a.audioKey]?.byteLength ?? 0)}</div>
                  </div>
                  <Button disabled={disabled} tone={muted ? "ghost" : "danger"} onClick={() => onChange({ ...edits, mutedAudio: muted ? edits.mutedAudio.filter((k) => k !== a.audioKey) : [...edits.mutedAudio, a.audioKey] })}>
                    {muted ? "Restore" : "Remove"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function RowActions({ disabled, gone, seq, onReplace, onDownload, onToggle, onRestore, onExpand, open }: { disabled?: boolean; gone: boolean; seq: boolean; onReplace: (f: File) => void; onDownload: () => void; onToggle: () => void; onRestore?: () => void; onExpand?: () => void; open: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <input ref={file} type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) onReplace(f); e.target.value = ""; }} />
      {onExpand && <IconBtn label={open ? "Hide frames" : "Show frames"} onClick={onExpand}>{open ? "▾" : "▸"}</IconBtn>}
      {!seq && !gone && <IconBtn label="Replace with an image (fitted to this size)" onClick={() => file.current?.click()} disabled={disabled}>⇄</IconBtn>}
      {onRestore && <IconBtn label="Undo the replacement" onClick={onRestore} disabled={disabled}>↺</IconBtn>}
      {!seq && <IconBtn label="Save as PNG" onClick={onDownload}>↓</IconBtn>}
      <IconBtn label={gone ? "Restore this layer" : "Delete this layer (and the sprites that draw it)"} onClick={onToggle} disabled={disabled}>{gone ? "↩" : "✕"}</IconBtn>
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className="h-7 w-7 rounded-lg text-xs text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30">{children}</button>
  );
}

function Thumb({ bytes, small }: { bytes: Uint8Array | undefined; small?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) return;
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffImageMime(bytes) }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes]);
  return (
    <div className={`${small ? "h-8 w-full" : "h-9 w-12"} shrink-0 rounded-md checkerboard bg-black/30 grid place-items-center overflow-hidden`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt="" className="max-h-full max-w-full object-contain" draggable={false} />}
    </div>
  );
}

function download(bytes: Uint8Array | undefined, name: string) {
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffImageMime(bytes) }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
