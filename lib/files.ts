"use client";

/**
 * Collect .svga files from a drop or a picker — loose files, whole folders
 * (recursively), or a folder chosen with the folder picker — keeping each
 * file's path inside what was dropped, so a batch can be zipped back with
 * the same folders.
 */
export type PickedFile = { file: File; path: string };

const isSvga = (name: string) => /\.svga$/i.test(name);

type Entry = FileSystemEntry;
type DirEntry = FileSystemDirectoryEntry;
type FileEntry = FileSystemFileEntry;

/** Everything dropped. Call synchronously inside the drop handler: the items expire after it returns. */
export function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: Entry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else { const f = item.getAsFile(); if (f) loose.push(f); }
  }
  if (!entries.length && !loose.length) loose.push(...Array.from(dt.files ?? []));
  return (async () => {
    const out: PickedFile[] = loose.filter((f) => isSvga(f.name)).map((file) => ({ file, path: file.name }));
    for (const e of entries) await walk(e, "", out);
    return sortPicked(out);
  })();
}

async function walk(entry: Entry, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    if (!isSvga(entry.name)) return;
    const file = await new Promise<File | null>((res) => (entry as FileEntry).file(res, () => res(null)));
    if (file) out.push({ file, path: prefix + entry.name });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as DirEntry).createReader();
  // readEntries returns the listing in chunks; keep asking until it's empty.
  for (;;) {
    const batch = await new Promise<Entry[]>((res) => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

/** Files from an <input type="file"> (with or without webkitdirectory). */
export function filesFromInput(list: FileList | null): PickedFile[] {
  if (!list) return [];
  return sortPicked(
    Array.from(list)
      .filter((f) => isSvga(f.name))
      .map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name })),
  );
}

export function sortPicked(list: PickedFile[]): PickedFile[] {
  return list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
