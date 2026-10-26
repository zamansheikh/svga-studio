// Copy the OCR engine (tesseract.js worker + wasm core) and the English
// model into public/ocr, so the studio serves them itself. Runs before
// `dev` and `build`; the folder is generated, not committed.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const out = path.join(root, "public", "ocr");
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

const copies = [
  [path.join(pkgDir("tesseract.js"), "dist", "worker.min.js"), "worker.min.js"],
  ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]
    .map((f) => [path.join(pkgDir("tesseract.js-core"), f), path.join("core", f)]),
  [path.join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz"), path.join("lang", "eng.traineddata.gz")],
];

let copied = 0;
for (const [src, rel] of copies) {
  if (!fs.existsSync(src)) continue;
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const fresh = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size;
  if (!fresh) { fs.copyFileSync(src, dst); copied++; }
}
console.log(`ocr assets ready in public/ocr (${copied} updated)`);
