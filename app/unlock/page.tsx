import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import PinForm from "@/components/PinForm";
import { configuredPin, LOCK_COOKIE, safeNext, tokenValid } from "@/lib/lock";

export const metadata: Metadata = {
  title: "Unlock",
  robots: { index: false, follow: false },
};

export default async function UnlockPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  // Already unlocked (a stale link or prefetch brought us here): go straight on.
  if (tokenValid((await cookies()).get(LOCK_COOKIE)?.value)) redirect(next);
  const configured = !!configuredPin();
  const tool = next === "/icons" ? "Batch icons" : "the editor";

  return (
    <main className="grid-bg grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link href="/" className="mx-auto mb-8 flex w-fit items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-500 shadow-lg shadow-brand-500/30">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white" aria-hidden><path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" /></svg>
          </span>
          <span className="text-sm font-semibold tracking-tight text-white">SVGA Studio</span>
        </Link>

        <div className="glass rounded-3xl p-6 text-center sm:p-8">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.06]">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-white/85" aria-hidden>
              <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9zm3 4a2 2 0 0 1 1 3.73V19h-2v-1.27A2 2 0 0 1 12 14z" />
            </svg>
          </span>
          <h1 className="mt-4 text-lg font-semibold text-white">The studio is locked</h1>
          {configured ? (
            <>
              <p className="mt-1 text-sm text-white/55">Enter the 4-digit PIN to open {tool}.</p>
              <PinForm next={next} />
            </>
          ) : (
            <p className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-left text-[13px] leading-relaxed text-amber-100/90">
              No PIN is set up for this site yet. The owner sets a 4-digit <code className="font-mono">STUDIO_PIN</code> in the
              server&apos;s environment (for example in the hosting dashboard) and redeploys.
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-white/40">
          <Link href="/" className="hover:text-white/70">← Back to the home page</Link>
        </p>
      </div>
    </main>
  );
}
