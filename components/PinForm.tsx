"use client";

import { useEffect, useRef, useState } from "react";

const LEN = 4;

/**
 * Four PIN boxes: digits only, the cursor moves on by itself, Backspace
 * goes back, a pasted PIN fills all four, and the fourth digit submits.
 */
export default function PinForm({ next }: { next: string }) {
  const [digits, setDigits] = useState<string[]>(Array(LEN).fill(""));
  const [state, setState] = useState<"idle" | "checking" | "wrong" | "ok">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => { boxes.current[0]?.focus(); }, []);

  // Count down a lockout.
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    if (wait === 1) setTimeout(() => { setMessage(null); boxes.current[0]?.focus(); }, 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = async (pin: string) => {
    setState("checking");
    setMessage(null);
    try {
      const res = await fetch("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; left?: number; retryAfter?: number };
      if (res.ok && body.ok) {
        setState("ok");
        // A full load: the browser's in-page router still remembers the tool
        // page as "locked" and would bounce back here. Files dropped on the
        // home page wait in IndexedDB (lib/handoff.ts).
        window.location.replace(next);
        return;
      }
      setState("wrong");
      if (body.retryAfter) { setWait(body.retryAfter); setMessage("Too many wrong PINs."); }
      else setMessage(body.error === "Wrong PIN." && body.left != null ? `Wrong PIN — ${body.left} ${body.left === 1 ? "try" : "tries"} left.` : body.error ?? "Couldn't check the PIN.");
    } catch {
      setState("wrong");
      setMessage("Couldn't reach the server. Check the connection and try again.");
    }
    setDigits(Array(LEN).fill(""));
    setTimeout(() => { setState("idle"); boxes.current[0]?.focus(); }, 450);
  };

  const fill = (from: number, chars: string) => {
    const only = chars.replace(/\D/g, "");
    if (!only) return;
    const nextDigits = [...digits];
    let i = from;
    for (const c of only) { if (i >= LEN) break; nextDigits[i++] = c; }
    setDigits(nextDigits);
    if (nextDigits.every(Boolean)) void submit(nextDigits.join(""));
    else boxes.current[Math.min(LEN - 1, i)]?.focus();
  };

  const locked = wait > 0;
  const busy = state === "checking" || state === "ok" || locked;

  return (
    <form className="mt-6" onSubmit={(e) => { e.preventDefault(); if (digits.every(Boolean)) void submit(digits.join("")); }}>
      <div className={`flex justify-center gap-3 ${state === "wrong" ? "animate-[shake_0.4s_ease-in-out]" : ""}`} role="group" aria-label="PIN">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { boxes.current[i] = el; }}
            value={d}
            disabled={busy}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            maxLength={LEN}
            aria-label={`Digit ${i + 1}`}
            type="password"
            onChange={(e) => {
              const v = e.target.value;
              if (!v) { const n = [...digits]; n[i] = ""; setDigits(n); return; }
              fill(i, v.slice(-LEN));
            }}
            onPaste={(e) => { e.preventDefault(); fill(0, e.clipboardData.getData("text")); }}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !digits[i] && i > 0) { e.preventDefault(); const n = [...digits]; n[i - 1] = ""; setDigits(n); boxes.current[i - 1]?.focus(); }
              else if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
              else if (e.key === "ArrowRight" && i < LEN - 1) boxes.current[i + 1]?.focus();
            }}
            onFocus={(e) => e.target.select()}
            className={`h-14 w-12 rounded-xl border bg-black/30 text-center text-2xl font-semibold text-white caret-brand-400 transition focus:outline-none focus:ring-2 disabled:opacity-60 sm:h-16 sm:w-14 ${
              state === "wrong" ? "border-red-400/60 focus:ring-red-400/40" : state === "ok" ? "border-emerald-400/60" : "border-white/15 focus:border-brand-400 focus:ring-brand-500/40"
            }`}
          />
        ))}
      </div>
      <p className={`mt-4 min-h-[1.25rem] text-sm ${state === "ok" ? "text-emerald-300" : "text-red-300"}`} role="status" aria-live="polite">
        {state === "ok" ? "Unlocked — opening…" : state === "checking" ? <span className="text-white/50">Checking…</span> : locked ? `${message} Try again in ${wait}s.` : message}
      </p>
    </form>
  );
}
