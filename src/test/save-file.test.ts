import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanFileName, saveWithPicker } from "@/components/cad/save-file";

type W = Window & { showSaveFilePicker?: unknown };
const w = window as W;
const blob = new Blob(["x"], { type: "application/dxf" });
const opts = { suggestedName: "a.dxf", description: "DXF", mime: "application/dxf", ext: ".dxf" };

function fakeHandle() {
  const writes: Blob[] = [];
  const handle = {
    createWritable: async () => ({
      write: async (b: Blob) => void writes.push(b),
      close: async () => {},
    }),
  };
  return { handle, writes };
}
const domError = (name: string) => Object.assign(new Error(name), { name });

afterEach(() => {
  delete w.showSaveFilePicker;
});

describe("saveWithPicker", () => {
  it("writes the file where the user chose, starting from the folder of the opened file", async () => {
    const { handle, writes } = fakeHandle();
    const picker = vi.fn().mockResolvedValue(handle);
    w.showSaveFilePicker = picker;
    const start = { kind: "file" } as unknown as FileSystemHandle;

    expect(await saveWithPicker(blob, { ...opts, startIn: start })).toBe("saved");
    expect(writes).toEqual([blob]);
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: "a.dxf", startIn: start }),
    );
  });

  it("reports unsupported when the browser has no save window", async () => {
    expect(await saveWithPicker(blob, opts)).toBe("unsupported");
  });

  it("reports unsupported when the browser refuses it (e.g. page inside another site)", async () => {
    w.showSaveFilePicker = vi.fn().mockRejectedValue(domError("SecurityError"));
    expect(await saveWithPicker(blob, opts)).toBe("unsupported");
  });

  it("reports cancelled, without downloading, when the user closes the window", async () => {
    w.showSaveFilePicker = vi.fn().mockRejectedValue(domError("AbortError"));
    expect(await saveWithPicker(blob, opts)).toBe("cancelled");
  });

  it("retries without the starting folder when the browser rejects it", async () => {
    const { handle, writes } = fakeHandle();
    const picker = vi
      .fn()
      .mockRejectedValueOnce(domError("TypeError"))
      .mockResolvedValueOnce(handle);
    w.showSaveFilePicker = picker;
    const start = {} as FileSystemHandle;

    expect(await saveWithPicker(blob, { ...opts, startIn: start })).toBe("saved");
    expect(picker).toHaveBeenCalledTimes(2);
    expect(picker.mock.calls[1]![0]).not.toHaveProperty("startIn");
    expect(writes).toHaveLength(1);
  });

  it("lets unexpected errors through instead of hiding them", async () => {
    w.showSaveFilePicker = vi.fn().mockRejectedValue(domError("QuotaExceededError"));
    await expect(saveWithPicker(blob, opts)).rejects.toThrow();
  });
});

describe("cleanFileName", () => {
  it("adds the extension once and removes characters a file name rejects", () => {
    expect(cleanFileName("pianta", ".dxf")).toBe("pianta.dxf");
    expect(cleanFileName("pianta.dxf", ".dxf")).toBe("pianta.dxf");
    expect(cleanFileName('a/b:c*"d', ".png")).toBe("a_b_c_d.png");
    expect(cleanFileName("   ", ".png")).toBe("disegno.png");
  });
});
