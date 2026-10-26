# SVGA Studio

Modern, 100% client-side editor for **SVGA** animation files (`.svga`): preview,
edit every kind of text in them, swap layers, compress, watermark.

Formerly *SVGA Compressor*; the old repository URL redirects here.
Built with Next.js 16, React 19, TypeScript, Tailwind. Deploys to Vercel in one click.

> Note: this is for **SVGA** (bitmap-based animation format used by live-streaming gift effects,
> stickers, etc.) — not for static SVG. For SVG, use SVGO.

## Features

- Opens **every SVGA**: 2.x (zlib, gzip, raw deflate or bare protobuf, extra bytes
  after the data tolerated) and 1.x (zip with `movie.spec` or `movie.binary`,
  converted on load; downloads as 2.x)
- Faithful preview: bitmaps, vector shapes, clip paths, masks (`matteKey`), sound,
  the file's own frame rate; frame stepping and PNG export of any frame
- **Edit every text in the file**, each on its own — see [Editing text](#editing-text)
- **Layers**: replace any bitmap with a picture (fitted to its exact size), delete a
  bitmap with every sprite that draws it, remove sounds; hidden layers flagged
- Merge identical bitmaps; strip hidden exporter metadata (tool, author email, timestamp)
- Quality, scale and output format (WebP / PNG / JPEG) controls; edited bitmaps are
  stored the way the originals were (palette PNG stays palette PNG)
- Series: one file per value (`1-20`, `Gold, Silver`) for any text, zipped
- Nothing leaves your browser — decode, edit, re-encode and compress happen on-device

## Tech

- `next@16` (App Router) · `react@19` · `tailwindcss@3`
- `protobufjs` (wire reader/writer) and `pako` — SVGA decode/encode, tolerant of exporter quirks
- Canvas / OffscreenCanvas — rendering, text detection, erasing and drawing
- `tesseract.js` — reads the text the detector found (served from `/ocr` by this site,
  copied there from `node_modules` by `scripts/copy-ocr.mjs` before `dev`/`build`)
- `next/font` — the bundled fonts for new text, self-hosted

## Local development

```bash
npm install
npm run dev
# open http://localhost:3000
```

`/lab` (development only, 404 in production) exposes the engine on `window.__lab`
for scripted checks.

## Build

```bash
npm run build
npm start
```

## Deploy on Vercel

1. Push this repo to GitHub.
2. Import into Vercel — the framework is detected automatically.
3. (Optional) set `NEXT_PUBLIC_SITE_URL` to your production URL so sitemap / robots / OG URLs
   reference the right origin.

Or just:

```bash
npx vercel
```

## Layout

Three columns. **Files** on the left lists everything you dropped and marks
which ones are siblings of the file being edited. The **Stage** in the middle
plays the animation in three views — *Original*, *Edited* (your edits, live),
*Result* (what you will download); keys 1/2/3 switch, space plays, `,` and `.`
step a frame. The **Inspector** on the right has four tabs — *Text*, *Layers*,
*Compress*, *Watermark* — and a footer with before/after size and a single
*Build → Download* action.

## Editing text

Open a file: the *Text* tab lists every text found in it, each with a crop of
the original and what it reads. Type into one to replace it; the stage shows
the result live. Text that isn't listed: press **Select text on the stage** and
drag a box around it.

What counts as text, and how each kind is edited:

| Kind | What it is | Edit |
| --- | --- | --- |
| **Text slot** | An empty bitmap the app fills at runtime (`name1`, `lvtag`, `text1`) | The text is drawn into it, centred like the players draw dynamic text. The app can still replace it. |
| **Image slot** | An empty bitmap for an avatar or gift (`avatar`, `gift`) | Choose a picture; it is fitted to the slot (optionally a circle). |
| **Text layer** | Letters on their own transparent layer, often stacked with a shadow and a highlight copy (`VIP 5`) | Each copy is cleared and redrawn — the main one in the new look, the copies in their own colours. |
| **On artwork** | Letters painted into a ribbon or plate, possibly into every frame of an image sequence | Only the letter pixels are erased (the background around them is filled in), then the new text is drawn, frame by frame; frames where the old text faded keep the fade. |
| **Hidden** | Text that never shows — 1% opacity or off the canvas, typically a seller's watermark | Delete the layer, or erase its text. |

**Finding text.** Each bitmap is searched on its own (one frame of each
sequence), so nothing drawn on top gets in the way: the bitmap is cut at
several brightness levels, for light and for dark lettering, and through its
transparency; blobs that look like glyphs (one even stroke width, sharp edges,
a sensible size) are chained into lines that share a baseline; ornaments are
filtered out (mirror-symmetric pairs, repeated studs, bands along a plate).
Text in a sequence must stay put from frame to frame. Then OCR reads each line
from the clean letter mask — read text is confirmed and shown; unreadable
candidates go under *possible*. When the other files of a numbered set are
loaded (level-41 … level-50), the bitmaps that differ between them are the
text, exactly, and the set's own digits are lifted so a new number can be
written in the original lettering.

**Matching the look.** The original letters are measured — height and
baseline, slant, stroke weight, fill (flat, or a top-to-bottom gradient) and
outline — and the new text starts in that look, in the bundled font whose
shapes are closest. Everything can be changed: font (or upload one), weight,
italic and slant, letter height, squeeze/shrink to fit, alignment, spacing,
colours and gradient stops, outline, shadow, position. The box on the stage
can be dragged and resized; the text follows it.

## How compression works

1. Read the uploaded `.svga` file.
2. `pako.inflate` the gzip, decode the `MovieEntity` protobuf (version, params, sprites,
   `images: map<string, bytes>`).
3. For each embedded bitmap (PNG/JPEG/WebP): decode it with `createImageBitmap`, draw it into
   a resized canvas, and export via `toBlob` at the chosen format/quality. If the re-encoded
   output is larger than the original, the original is kept.
4. Re-serialize the `MovieEntity` and `pako.deflate` at max level.
5. Offer the result as `filename.min.svga`.

Animation timing, sprite transforms and shape layers are preserved exactly — only the embedded
bitmap images are touched. With **Merge identical bitmaps** on, byte-identical images are
stored once and their sprites re-pointed. **Strip exporter metadata** drops unknown header
fields — some exporters put a base64 JSON tag there with the tool name, author email and
timestamp.

## Compatibility

- **WebP** — smallest with transparency. Supported by SVGAPlayer v2.x on Android / iOS / Web.
- **PNG** — lossless. Safe for any SVGA 2.x player, but may shrink less.
- **JPEG** — drops transparency. Only for opaque animations.

## License

MIT
