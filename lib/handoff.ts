"use client";

import type { PickedFile } from "./files";

/**
 * Files dropped on the landing page, carried into the tool page. Client-side
 * navigation keeps this module alive, so the File objects travel as they are
 * — nothing is uploaded or copied.
 */
type Pending = { mode: "edit" | "icons"; files: PickedFile[] };

let pending: Pending | null = null;

export function handOff(mode: Pending["mode"], files: PickedFile[]) {
  pending = files.length ? { mode, files } : null;
}

/** The files waiting for this tool, once. */
export function takeHandoff(): Pending | null {
  const p = pending;
  pending = null;
  return p;
}
