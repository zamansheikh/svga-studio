"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { filesFromDrop, filesFromInput, type PickedFile } from "@/lib/files";
import { handOff } from "@/lib/handoff";

/**
 * The two ways in, as cards. Each card opens its tool; dropping files on a
 * card opens the tool with those files already loaded.
 */
const TOOLS = [
  {
    mode: "edit" as const,
    href: "/edit",
    title: "Edit a file",
    cta: "Open the editor",
    points: ["Every text found and listed — retype it in the same look", "Swap pictures and layers, remove sounds", "Compress, watermark, download"],
    drop: "Drop an .svga here — or a whole set (level-1 … level-50)",
    accent: "from-brand-500 to-violet-500",
    icon: <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />,
  },
  {
    mode: "icons" as const,
    href: "/icons",
    title: "Batch icons",
    cta: "Open batch icons",
    points: ["Hundreds of files or whole folders at once", "Best frame picked for you, or choose one", "PNG, WebP or JPEG — all in one zip"],
    drop: "Drop files or folders here",
    accent: "from-fuchsia-500 to-brand-500",
    icon: <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />,
  },
];

export default function LandingTools() {
  const router = useRouter();

  // Old links to the batch tool (/#icons) now go to its page.
  useEffect(() => { if (location.hash === "#icons") router.replace("/icons"); }, [router]);

  const open = async (mode: "edit" | "icons", href: string, files: PickedFile[]) => {
    if (!files.length) return;
    await handOff(mode, files);
    router.push(href);
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {TOOLS.map((t) => <ToolCard key={t.mode} tool={t} onFiles={(f) => void open(t.mode, t.href, f)} />)}
    </div>
  );
}

function ToolCard({ tool, onFiles }: { tool: (typeof TOOLS)[number]; onFiles: (f: PickedFile[]) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); void filesFromDrop(e.dataTransfer).then(onFiles); }}
      className={`glass flex flex-col rounded-3xl p-5 transition sm:p-6 ${over ? "ring-2 ring-brand-400 bg-brand-500/10" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span className={`grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br ${tool.accent} shadow-lg shadow-brand-500/20`}>
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white" aria-hidden>{tool.icon}</svg>
        </span>
        <h2 className="text-lg font-semibold text-white">{tool.title}</h2>
      </div>
      <ul className="mt-4 space-y-1.5 text-sm text-white/65">
        {tool.points.map((p) => (
          <li key={p} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-white/40" />{p}</li>
        ))}
      </ul>
      <button type="button" onClick={() => input.current?.click()}
        className={`mt-5 rounded-2xl border-2 border-dashed px-4 py-6 text-center text-sm transition ${over ? "border-brand-400 text-white" : "border-white/10 text-white/50 hover:border-white/25 hover:text-white/75"}`}>
        {tool.drop}
        <span className="mt-1 block text-xs text-white/35">or click to choose files</span>
      </button>
      <input ref={input} type="file" accept=".svga" multiple className="sr-only" onChange={(e) => { onFiles(filesFromInput(e.target.files)); e.target.value = ""; }} />
      <Link href={tool.href}
        className={`mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r ${tool.accent} px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-500/20 transition hover:brightness-110`}>
        {tool.cta} <span aria-hidden>→</span>
      </Link>
    </div>
  );
}
