/**
 * Saving a file the way the user expects: a "Save as" window where they pick the folder and
 * the name, starting from the folder the drawing was opened from.
 *
 * Browsers that cannot do this (Firefox, Safari, or a page embedded in another site) get
 * "unsupported": the caller tells the user and, once they agree, falls back to a plain download.
 */

export type SaveResult = "saved" | "cancelled" | "unsupported";

type SaveFileType = { description: string; accept: Record<string, string[]> };
type SavePickerOptions = {
  suggestedName: string;
  startIn?: FileSystemHandle;
  types: SaveFileType[];
};
type PickerWindow = Window & {
  showSaveFilePicker?: (o: SavePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (o: {
    types: SaveFileType[];
    multiple: false;
  }) => Promise<FileSystemFileHandle[]>;
};

export const canPickLocation = () =>
  typeof window !== "undefined" &&
  typeof (window as PickerWindow).showSaveFilePicker === "function";

export const canPickFileToOpen = () =>
  typeof window !== "undefined" &&
  typeof (window as PickerWindow).showOpenFilePicker === "function";

const errName = (err: unknown) => (err instanceof Error ? err.name : "");

/**
 * Open the system file picker for a DXF. Unlike <input type="file"> it returns a handle, which
 * lets the save window start in the same folder. Returns null when the user cancels, and
 * "unsupported" when the browser refuses (the caller then uses the normal input).
 */
export async function pickFileToOpen(): Promise<
  { file: File; handle: FileSystemFileHandle } | null | "unsupported"
> {
  const w = window as PickerWindow;
  if (!w.showOpenFilePicker) return "unsupported";
  try {
    const [handle] = await w.showOpenFilePicker({
      multiple: false,
      types: [{ description: "Disegno DXF", accept: { "application/dxf": [".dxf"] } }],
    });
    if (!handle) return null;
    return { file: await handle.getFile(), handle };
  } catch (err) {
    if (errName(err) === "AbortError") return null;
    return "unsupported";
  }
}

export async function saveWithPicker(
  blob: Blob,
  o: {
    suggestedName: string;
    description: string;
    mime: string;
    ext: string;
    startIn?: FileSystemHandle | null;
  },
): Promise<SaveResult> {
  const w = window as PickerWindow;
  if (!w.showSaveFilePicker) return "unsupported";
  const types = [{ description: o.description, accept: { [o.mime]: [o.ext] } }];
  const attempt = (startIn?: FileSystemHandle | null) =>
    w.showSaveFilePicker!({
      suggestedName: o.suggestedName,
      types,
      ...(startIn ? { startIn } : {}),
    });
  try {
    let handle: FileSystemFileHandle;
    try {
      handle = await attempt(o.startIn);
    } catch (err) {
      // a stale or invalid starting folder must not block saving: retry without it
      if (o.startIn && errName(err) === "TypeError") handle = await attempt(null);
      else throw err;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "saved";
  } catch (err) {
    const name = errName(err);
    if (name === "AbortError") return "cancelled";
    // SecurityError: page inside another site; NotAllowedError: no recent click
    if (name === "SecurityError" || name === "NotAllowedError" || name === "TypeError")
      return "unsupported";
    throw err;
  }
}

/** Plain browser download (goes to the Downloads folder unless the browser is set to ask). */
export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoking right away can cancel the download in Firefox and Safari
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Make sure a name ends with the wanted extension and has no characters a file name rejects. */
export function cleanFileName(name: string, ext: string): string {
  const base = name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim()
    .replace(/\.(dxf|png|dwg)$/i, "");
  return (base || "disegno") + ext;
}
