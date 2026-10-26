import LandingTools from "@/components/LandingTools";
import Link from "next/link";

export default function Home() {
  return (
    <main className="grid-bg relative min-h-dvh">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 mb-10 sm:mb-14">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-brand-500 to-violet-500 grid place-items-center shadow-lg shadow-brand-500/30">
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white" aria-hidden>
                <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" />
              </svg>
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">SVGA Studio</div>
              <div className="text-[11px] text-white/50">for .svga animations</div>
            </div>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/edit" className="hidden rounded-lg px-3 py-1.5 text-white/65 hover:bg-white/5 hover:text-white sm:block">Editor</Link>
            <Link href="/icons" className="hidden rounded-lg px-3 py-1.5 text-white/65 hover:bg-white/5 hover:text-white sm:block">Batch icons</Link>
            <a href="#faq" className="hidden rounded-lg px-3 py-1.5 text-white/65 hover:bg-white/5 hover:text-white md:block">FAQ</a>
            <Link href="/edit" className="ml-1 rounded-lg bg-white px-3.5 py-1.5 text-sm font-semibold text-[#070914] hover:bg-white/90">Open the app</Link>
          </nav>
        </header>

        {/* Hero */}
        <section className="mb-8 sm:mb-10 text-center">
          <h1 className="mx-auto max-w-3xl text-3xl sm:text-5xl font-bold tracking-tight leading-[1.08]">
            Edit and shrink <span className="gradient-text">.svga</span> animations, in your browser.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm sm:text-base text-white/60">
            Retype any name, level or rank in its original look, swap pictures, compress — or turn a
            whole folder of animations into icons. Free, no sign-up, and nothing is uploaded.
          </p>
        </section>

        {/* The two tools */}
        <LandingTools />

        {/* Feature strip */}
        <section className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Feature
            title="Private by default"
            body="Files never leave your browser. No backend, no tracking."
            icon={
              <path d="M12 1 3 5v6c0 5.25 3.75 10.16 9 11 5.25-.84 9-5.75 9-11V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
            }
          />
          <Feature
            title="Preview before & after"
            body="Bitmaps, vector shapes, masks and sound, at the file's own frame rate — SVGA 1.x and 2.x."
            icon={<path d="M8 5v14l11-7z" />}
          />
          <Feature
            title="Batch icons"
            body="Drop hundreds of files or whole folders; get a still of each — best frame picked for you — as one zip."
            icon={<path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />}
          />
          <Feature
            title="Mobile friendly"
            body="Responsive, touch-optimized UI. Works on phones, tablets and desktops."
            icon={
              <path d="M17 1H7c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm-5 21c-.83 0-1.5-.67-1.5-1.5S11.17 19 12 19s1.5.67 1.5 1.5S12.83 22 12 22zm5-4H7V4h10v14z" />
            }
          />
        </section>

        {/* FAQ */}
        <section id="faq" className="mt-16 scroll-mt-6 space-y-6">
          <h2 className="text-xl font-semibold">FAQ</h2>
          <Faq q="What is an SVGA file?">
            SVGA is a bitmap-based animation format (.svga) used widely for live-streaming gifts,
            stickers, and in-app effects. Inside each file is a gzipped protobuf containing
            movie params, transformed sprite frames, and one or more embedded bitmap images.
          </Faq>
          <Faq q="How does compression work here?">
            The tool decodes your file, re-encodes each embedded bitmap using the browser's
            Canvas APIs (optional resize, WebP / PNG / JPEG), then re-serializes the protobuf
            and re-gzips it. Animation timing and transforms are preserved exactly.
          </Faq>
          <Faq q="Will the output still play in my player?">
            If your player is SVGAPlayer 2.x on Android / iOS / Web, WebP embeds are supported.
            If you target older players, choose PNG to stay fully lossless and compatible.
          </Faq>
          <Faq q="How does editing text work?">
            Every layer of the file is searched for lettering, and what is found is read with OCR
            and listed: empty name slots your app fills at runtime, letters on their own layer
            (with their shadow and highlight copies), letters painted into the artwork — even into
            every frame of an image sequence — and hidden text such as a seller&apos;s watermark.
            Type over one and only its letters are erased; the new text is drawn in the measured
            look (height, slant, weight, gradient, outline) and the closest font, which you can
            change. Anything not listed: draw a box around it on the stage.
          </Faq>
          <Faq q="How do I make icons for many files?">
            Open Batch icons and drop the files, or whole folders. Each animation is rendered at
            its most detailed frame (or the start, middle or end, or a frame you pick per file),
            trimmed and sized to your settings — PNG, WebP or JPEG — and everything downloads as one
            zip that keeps your folders.
          </Faq>
          <Faq q="Which SVGA files open?">
            All of them: SVGA 2.x compressed with zlib or gzip, raw deflate or not at all (even with
            junk bytes after the data), and SVGA 1.x zip files with movie.spec or movie.binary. 1.x
            files download as 2.x, which every current player reads.
          </Faq>
          <Faq q="Is SVG supported?">
            No — this tool is specifically for SVGA (animation). For static SVG files, use a
            different optimizer such as SVGO.
          </Faq>
        </section>

        {/* Footer */}
        <footer className="mt-16 border-t border-white/5 pt-6 text-xs text-white/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            Built with Next.js 16, React 19, Tailwind. Deploy to{" "}
            <Link href="https://vercel.com" className="underline hover:text-white/70">
              Vercel
            </Link>{" "}
            in one click.
          </div>
          <div>© {new Date().getFullYear()} SVGA Studio</div>
        </footer>
      </div>
    </main>
  );
}

function Feature({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="h-9 w-9 rounded-lg bg-white/5 grid place-items-center mb-3">
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white/80">
          {icon}
        </svg>
      </div>
      <div className="text-sm font-medium text-white">{title}</div>
      <div className="text-xs text-white/60 mt-1 leading-relaxed">{body}</div>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="glass rounded-2xl px-5 py-4 group">
      <summary className="cursor-pointer list-none flex items-center justify-between text-sm font-medium text-white">
        {q}
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 fill-white/60 transition-transform group-open:rotate-180"
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </summary>
      <p className="mt-3 text-sm text-white/60 leading-relaxed">{children}</p>
    </details>
  );
}
