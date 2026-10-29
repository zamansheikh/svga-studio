"use client";

import type { PickedFile } from "./files";

/**
 * Files dropped on the landing page, carried into the tool page.
 *
 * Kept in memory for a client-side navigation, and in IndexedDB (this
 * browser only — nothing is uploaded) so they survive the full page load
 * that follows entering the studio PIN. Taken once; stale ones are ignored.
 */
type Pending = { mode: "edit" | "icons"; files: PickedFile[] };
type Stored = Pending & { at: number };

const DB = "svga-studio";
const STORE = "handoff";
const KEY = "pending";
const MAX_AGE = 15 * 60 * 1000;

let pending: Pending | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function handOff(mode: Pending["mode"], files: PickedFile[]): Promise<void> {
  pending = files.length ? { mode, files } : null;
  try {
    if (files.length) {
      const record: Stored = { mode, files, at: Date.now() };
      await run("readwrite", (s) => s.put(record, KEY));
    } else await run("readwrite", (s) => s.delete(KEY));
  } catch {
    /* private mode or storage blocked: the in-memory copy still covers a direct visit */
  }
}

/** The files waiting for a tool, once. */
export async function takeHandoff(): Promise<Pending | null> {
  const mem = pending;
  pending = null;
  let stored: Stored | undefined;
  try {
    stored = (await run("readonly", (s) => s.get(KEY))) as Stored | undefined;
    if (stored) await run("readwrite", (s) => s.delete(KEY));
  } catch {
    stored = undefined;
  }
  if (mem) return mem;
  if (stored && Date.now() - stored.at < MAX_AGE && stored.files?.length) return { mode: stored.mode, files: stored.files };
  return null;
}
