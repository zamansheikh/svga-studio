"use client";

import type { ReactNode } from "react";

/* Small controls shared by the inspector panels. */

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (b: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40 ${checked ? "bg-gradient-to-r from-brand-500 to-violet-500" : "bg-white/15"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

export function Slider({ label, value, onChange, min, max, step, suffix, disabled, format }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; suffix?: string; disabled?: boolean; format?: (v: number) => string }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-white/70">{label}</span>
        <span className="text-xs font-mono text-white/60 tabular-nums">{format ? format(value) : value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} className="mt-1" />
    </label>
  );
}

export function ColorInput({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label?: string }) {
  return (
    <label className="inline-flex items-center gap-1.5" title={label}>
      <input type="color" value={normalizeHex(value)} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={label}
        className="h-7 w-8 rounded cursor-pointer bg-transparent border border-white/10 disabled:opacity-40" />
      <span className="text-[10px] font-mono text-white/55 uppercase">{normalizeHex(value).slice(1)}</span>
    </label>
  );
}

export function normalizeHex(h: string): string {
  if (/^#[0-9a-f]{6}$/i.test(h)) return h.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(h)) return `#${h.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
  return "#ffffff";
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (b: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-2 cursor-pointer text-xs text-white/70 ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} className="h-4 w-4 accent-brand-500" />
      <span className="truncate">{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div className="flex gap-1 rounded-lg bg-white/5 p-1" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled} title={o.title} onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition disabled:opacity-40 ${value === o.value ? "bg-white text-[#070914] shadow" : "text-white/70 hover:text-white hover:bg-white/10"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info"; title?: string }) {
  const cls = {
    neutral: "bg-white/10 text-white/70",
    good: "bg-emerald-500/15 text-emerald-300",
    warn: "bg-amber-500/15 text-amber-200",
    bad: "bg-red-500/15 text-red-300",
    info: "bg-sky-500/15 text-sky-200",
  }[tone];
  return <span title={title} className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>;
}

export function Button({ children, onClick, disabled, tone = "ghost", className = "", title, type = "button" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: "primary" | "ghost" | "danger"; className?: string; title?: string; type?: "button" | "submit" }) {
  const cls = {
    primary: "bg-brand-500 hover:bg-brand-400 text-white",
    ghost: "bg-white/5 hover:bg-white/10 text-white/80",
    danger: "bg-red-500/15 hover:bg-red-500/25 text-red-200",
  }[tone];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${cls} ${className}`}>
      {children}
    </button>
  );
}
