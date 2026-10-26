"use client";

import { useCallback, useEffect, useState } from "react";
import Workspace from "./Workspace";
import IconBatch from "./IconBatch";
import type { PickedFile } from "@/lib/files";

type Mode = "edit" | "icons";

const MODES: { id: Mode; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "edit", label: "Edit a file", hint: "Change text and layers, compress, watermark", icon: <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /> },
  { id: "icons", label: "Batch icons", hint: "Many files → a still image of each, as one zip", icon: <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" /> },
];

/**
 * The two tools, side by side behind a switch. Both stay mounted, so
 * switching back and forth keeps each one's work. The address bar follows
 * the mode (#icons), so a link can open the batch tool directly.
 */
export default function Studio() {
  const [mode, setMode] = useState<Mode>("edit");
  const [toIcons, setToIcons] = useState<{ files: PickedFile[]; nonce: number } | null>(null);
  const [toEdit, setToEdit] = useState<{ files: File[]; nonce: number } | null>(null);

  useEffect(() => {
    const read = () => setMode(location.hash === "#icons" ? "icons" : "edit");
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const go = useCallback((m: Mode) => {
    setMode(m);
    const url = m === "icons" ? "#icons" : location.pathname + location.search;
    history.replaceState(null, "", url);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2" role="tablist" aria-label="Tool">
        {MODES.map((m) => {
          const on = mode === m.id;
          return (
            <button key={m.id} type="button" role="tab" aria-selected={on} onClick={() => go(m.id)}
              className={`flex items-center gap-3 rounded-2xl border px-4 py-2.5 text-left transition ${on ? "border-brand-400/60 bg-white/[0.08] shadow-lg shadow-brand-500/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"}`}>
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${on ? "bg-gradient-to-br from-brand-500 to-violet-500" : "bg-white/10"}`}>
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white">{m.icon}</svg>
              </span>
              <span>
                <span className="block text-sm font-medium text-white">{m.label}</span>
                <span className="block text-[11px] text-white/50">{m.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className={mode === "edit" ? "" : "hidden"}>
        <Workspace incoming={toEdit} active={mode === "edit"}
          onMakeIcons={(files) => { setToIcons({ files: files.map((file) => ({ file, path: file.name })), nonce: Date.now() }); go("icons"); }} />
      </div>
      <div className={mode === "icons" ? "" : "hidden"}>
        <IconBatch incoming={toIcons} active={mode === "icons"}
          onEdit={(file) => { setToEdit({ files: [file], nonce: Date.now() }); go("edit"); }} />
      </div>
    </div>
  );
}
