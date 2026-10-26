"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Workspace from "./Workspace";
import IconBatch from "./IconBatch";
import type { PickedFile } from "@/lib/files";
import { takeHandoff } from "@/lib/handoff";

type Mode = "edit" | "icons";

const TABS: { id: Mode; href: string; label: string; icon: React.ReactNode }[] = [
  { id: "edit", href: "/edit", label: "Editor", icon: <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /> },
  { id: "icons", href: "/icons", label: "Batch icons", icon: <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" /> },
];

/**
 * The app: a slim top bar and the tool filling the window, like a desktop
 * editor. Both tools stay mounted, so switching between /edit and /icons
 * keeps each one's work; the URL says which is showing.
 */
export default function Studio() {
  const pathname = usePathname();
  const router = useRouter();
  const mode: Mode = pathname.startsWith("/icons") ? "icons" : "edit";
  const [toIcons, setToIcons] = useState<{ files: PickedFile[]; nonce: number } | null>(null);
  const [toEdit, setToEdit] = useState<{ files: File[]; nonce: number } | null>(null);

  // Files dropped on the landing page.
  useEffect(() => {
    const p = takeHandoff();
    if (!p) return;
    if (p.mode === "icons") setToIcons({ files: p.files, nonce: Date.now() });
    else setToEdit({ files: p.files.map((f) => f.file), nonce: Date.now() });
  }, []);

  const go = useCallback((m: Mode) => router.push(m === "icons" ? "/icons" : "/edit"), [router]);

  return (
    <div className="flex min-h-dvh flex-col bg-[#080a13] text-white lg:h-dvh lg:overflow-hidden">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.07] bg-[#0b0d19]/95 px-2 backdrop-blur sm:px-3">
        <Link href="/" className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-white/5" title="SVGA Studio home">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-violet-500">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden><path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" /></svg>
          </span>
          <span className="hidden text-sm font-semibold tracking-tight sm:block">SVGA Studio</span>
        </Link>
        <span className="mx-1 hidden h-5 w-px bg-white/10 sm:block" />
        <nav className="flex items-center gap-1" aria-label="Tools">
          {TABS.map((t) => {
            const on = t.id === mode;
            return (
              <Link key={t.id} href={t.href} aria-current={on ? "page" : undefined}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition ${on ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white"}`}>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden>{t.icon}</svg>
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-2 hidden items-center gap-1.5 text-[11px] text-white/45 md:flex" title="Files are opened and processed in this browser only">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Files stay on this device
          </span>
          <Shortcuts mode={mode} />
          <Link href="/#faq" className="rounded-lg px-2.5 py-1.5 text-[13px] text-white/60 hover:bg-white/5 hover:text-white">Help</Link>
        </div>
      </header>

      <main className="relative flex-1 lg:min-h-0">
        <div className={mode === "edit" ? "h-full" : "hidden"}>
          <Workspace incoming={toEdit} active={mode === "edit"}
            onMakeIcons={(files) => { setToIcons({ files: files.map((file) => ({ file, path: file.name })), nonce: Date.now() }); go("icons"); }} />
        </div>
        <div className={mode === "icons" ? "h-full" : "hidden"}>
          <IconBatch incoming={toIcons} active={mode === "icons"}
            onEdit={(file) => { setToEdit({ files: [file], nonce: Date.now() }); go("edit"); }} />
        </div>
      </main>
    </div>
  );
}

const KEYS: Record<Mode, [string, string][]> = {
  edit: [["1 2 3", "Original / Edited / Result"], ["Space", "Play / pause"], [", .", "Previous / next frame"], ["Esc", "Stop drawing a box, deselect"]],
  icons: [["Drop", "Files or folders anywhere on the grid"], ["↻", "Pick one file's frame"]],
};

function Shortcuts({ mode }: { mode: Mode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative hidden md:block">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Keyboard shortcuts"
        className={`rounded-lg px-2.5 py-1.5 text-[13px] transition ${open ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white"}`}>
        Shortcuts
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-white/10 bg-[#121527] p-3 shadow-2xl shadow-black/50">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/45">{mode === "edit" ? "Editor" : "Batch icons"}</div>
          <dl className="space-y-1.5">
            {KEYS[mode].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 text-xs">
                <dt className="flex gap-1">{k.split(" ").map((x) => <kbd key={x} className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/80">{x}</kbd>)}</dt>
                <dd className="text-right text-white/60">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
