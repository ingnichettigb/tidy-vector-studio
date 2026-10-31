import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas, Line, Rect, Point, type FabricObject } from "fabric";
import {
  MousePointer2,
  Hand,
  Minus,
  Square,
  Eraser,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Upload,
  Download,
  Loader2,
  Terminal,
} from "lucide-react";
import { PALETTE, buildMockDrawing, toDxf, type Tool, type Ent } from "./cad-data";
import { DrawingLayer } from "./drawing-layer";
import { parseDxf } from "./dxf-import";

// Rubber-band preview shown while drawing a new line/rectangle (the finished shape is
// committed to the DrawingLayer on mouse up).
const previewProps = {
  selectable: false,
  evented: false,
  hasControls: false,
  strokeWidth: 2,
  strokeUniform: true,
};

export default function CadEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLCanvasElement>(null);
  const cvRef = useRef<Canvas | null>(null);
  const layerRef = useRef<DrawingLayer>(new DrawingLayer());
  const [tool, setTool] = useState<Tool>("select");
  const toolRef = useRef<Tool>("select");
  const [color, setColor] = useState<string>(PALETTE[0]!.value);
  const colorRef = useRef(color);
  const [history, setHistory] = useState<string[]>(["Disegno di esempio caricato"]);
  const [cmd, setCmd] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [fileName, setFileName] = useState("esempio_pianta.dwg");
  const [dragOver, setDragOver] = useState(false);
  const [zoom, setZoom] = useState(1);

  const log = useCallback((m: string) => setHistory((h) => [...h, m].slice(-3)), []);
  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  const applyTool = useCallback((t: Tool) => {
    toolRef.current = t;
    setTool(t);
    const cv = cvRef.current;
    if (!cv) return;
    layerRef.current.selected.clear();
    cv.defaultCursor = t === "pan" ? "grab" : t === "select" ? "default" : "crosshair";
    cv.requestRenderAll();
  }, []);

  const zoomExtents = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const b = layerRef.current.bounds();
    cv.setViewportTransform([1, 0, 0, 1, 0, 0]);
    if (!b) {
      setZoom(1);
      return;
    }
    const bw = b.x2 - b.x1 || 1,
      bh = b.y2 - b.y1 || 1;
    const pad = 60,
      W = cv.getWidth(),
      H = cv.getHeight();
    const z = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    cv.setViewportTransform([z, 0, 0, z, (W - bw * z) / 2 - b.x1 * z, (H - bh * z) / 2 - b.y1 * z]);
    setZoom(z);
  }, []);

  const zoomBy = useCallback((f: number) => {
    const cv = cvRef.current;
    if (!cv) return;
    const z = Math.min(40, Math.max(0.05, cv.getZoom() * f));
    cv.zoomToPoint(new Point(cv.getWidth() / 2, cv.getHeight() / 2), z);
    setZoom(z);
  }, []);

  const loadDrawing = useCallback(
    (src: number | Ent[]) => {
      const cv = cvRef.current;
      if (!cv) return;
      layerRef.current = new DrawingLayer(typeof src === "number" ? buildMockDrawing(src) : src);
      zoomExtents();
      cv.requestRenderAll();
    },
    [zoomExtents],
  );

  const deleteSelected = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const n = layerRef.current.removeSelected();
    if (!n) {
      log("Nessun elemento selezionato");
      return;
    }
    cv.requestRenderAll();
    log(n > 1 ? `${n} elementi eliminati` : "Elemento eliminato");
  }, [log]);

  // init canvas
  useEffect(() => {
    const host = hostRef.current!,
      el = elRef.current!;
    const cv = new Canvas(el, {
      width: host.clientWidth,
      height: host.clientHeight,
      selection: false,
      skipTargetFind: true, // picking is done on the DrawingLayer, not on canvas objects
      backgroundColor: "transparent",
    });
    cvRef.current = cv;

    let drawing: FabricObject | null = null,
      start: Point | null = null,
      end: Point | null = null,
      drawColor = "",
      panning = false,
      erasing = false,
      erased = 0,
      marquee: { x0: number; y0: number; x1: number; y1: number } | null = null,
      last = { x: 0, y: 0 };

    // The drawing is painted by the DrawingLayer under Fabric's own objects (the preview),
    // selection highlight and rubber-band box on top.
    cv.on("before:render", ({ ctx }) =>
      layerRef.current.draw(ctx, cv.viewportTransform, cv.getWidth(), cv.getHeight()),
    );
    cv.on("after:render", ({ ctx }) => {
      layerRef.current.drawSelection(ctx, cv.viewportTransform);
      if (marquee) {
        const x = Math.min(marquee.x0, marquee.x1),
          y = Math.min(marquee.y0, marquee.y1);
        ctx.save();
        ctx.fillStyle = "rgba(80,160,255,0.15)";
        ctx.strokeStyle = "#3b9cff";
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0));
        ctx.strokeRect(x, y, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0));
        ctx.restore();
      }
    });

    // Erase the topmost element near a scene point.
    const eraseAt = (x: number, y: number) => {
      const L = layerRef.current;
      const i = L.hitAt(x, y, 6 / cv.getZoom());
      if (i >= 0 && L.remove(i)) {
        erased++;
        cv.requestRenderAll();
      }
    };
    // Erase everything the pointer crossed since the last event: check intermediate points,
    // otherwise a fast swipe can jump over thin lines.
    let lastErase: { x: number; y: number } | null = null;
    const sweepErase = (ev: MouseEvent) => {
      const p = cv.getScenePoint(ev);
      const from = lastErase ?? p;
      const dx = p.x - from.x,
        dy = p.y - from.y;
      const steps = Math.max(1, Math.ceil((Math.hypot(dx, dy) * cv.getZoom()) / 4));
      for (let i = 1; i <= steps; i++)
        eraseAt(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
      lastErase = { x: p.x, y: p.y };
    };

    cv.on("mouse:down", (opt) => {
      const t = toolRef.current;
      const ev = opt.e as MouseEvent;
      if (t === "erase" && ev.button !== 1) {
        erasing = true;
        erased = 0;
        lastErase = null;
        sweepErase(ev);
        return;
      }
      if (t === "pan" || ev.button === 1) {
        panning = true;
        last = { x: ev.clientX, y: ev.clientY };
        cv.setCursor("grabbing");
        return;
      }
      if (t === "select") {
        const L = layerRef.current;
        const p = cv.getScenePoint(ev);
        const i = L.hitAt(p.x, p.y, 6 / cv.getZoom());
        if (i >= 0) {
          if (ev.shiftKey && L.selected.has(i)) L.selected.delete(i);
          else {
            if (!ev.shiftKey) L.selected.clear();
            L.selected.add(i);
          }
        } else {
          // empty space: start a selection box (window selection)
          if (!ev.shiftKey) L.selected.clear();
          const v = cv.getViewportPoint(ev);
          marquee = { x0: v.x, y0: v.y, x1: v.x, y1: v.y };
        }
        cv.requestRenderAll();
        return;
      }
      if (t === "line" || t === "rect") {
        start = end = cv.getScenePoint(ev);
        drawColor = colorRef.current;
        drawing =
          t === "line"
            ? new Line([start.x, start.y, start.x, start.y], { stroke: drawColor, ...previewProps })
            : new Rect({
                left: start.x,
                top: start.y,
                width: 0,
                height: 0,
                fill: "transparent",
                stroke: drawColor,
                ...previewProps,
              });
        cv.add(drawing);
      }
    });
    cv.on("mouse:move", (opt) => {
      const ev = opt.e as MouseEvent;
      if (panning) {
        const vpt = cv.viewportTransform!;
        vpt[4] += ev.clientX - last.x;
        vpt[5] += ev.clientY - last.y;
        last = { x: ev.clientX, y: ev.clientY };
        cv.setViewportTransform(vpt);
        return;
      }
      if (erasing) {
        sweepErase(ev);
        return;
      }
      if (marquee) {
        const v = cv.getViewportPoint(ev);
        marquee.x1 = v.x;
        marquee.y1 = v.y;
        cv.requestRenderAll();
        return;
      }
      if (!drawing || !start) return;
      const p = (end = cv.getScenePoint(ev));
      if (drawing instanceof Line) drawing.set({ x2: p.x, y2: p.y });
      else
        drawing.set({
          left: Math.min(p.x, start.x),
          top: Math.min(p.y, start.y),
          width: Math.abs(p.x - start.x),
          height: Math.abs(p.y - start.y),
        });
      drawing.setCoords();
      cv.requestRenderAll();
    });
    cv.on("mouse:up", () => {
      if (panning) {
        panning = false;
        cv.setCursor(toolRef.current === "pan" ? "grab" : "default");
        return;
      }
      if (erasing) {
        erasing = false;
        lastErase = null;
        if (erased) log(erased > 1 ? `${erased} elementi cancellati` : "Elemento cancellato");
        return;
      }
      if (marquee) {
        const m = marquee;
        marquee = null;
        if (Math.abs(m.x1 - m.x0) > 3 || Math.abs(m.y1 - m.y0) > 3) {
          const vpt = cv.viewportTransform!;
          const toScene = (x: number, y: number) => ({
            x: (x - vpt[4]!) / vpt[0]!,
            y: (y - vpt[5]!) / vpt[3]!,
          });
          const L = layerRef.current;
          for (const i of L.insideRect(toScene(m.x0, m.y0), toScene(m.x1, m.y1))) L.selected.add(i);
        }
        cv.requestRenderAll();
        return;
      }
      if (drawing && start && end) {
        const isLine = drawing instanceof Line;
        cv.remove(drawing);
        const dx = end.x - start.x,
          dy = end.y - start.y;
        if (isLine && Math.hypot(dx, dy) >= 2) {
          layerRef.current.add({
            type: "line",
            x1: start.x,
            y1: start.y,
            x2: end.x,
            y2: end.y,
            color: drawColor,
            w: 2,
          });
          log("Linea creata");
        } else if (!isLine && Math.abs(dx) >= 2 && Math.abs(dy) >= 2) {
          layerRef.current.add({
            type: "rect",
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            w: Math.abs(dx),
            h: Math.abs(dy),
            color: drawColor,
            sw: 2,
          });
          log("Rettangolo creato");
        }
        drawing = null;
        start = end = null;
        cv.requestRenderAll();
      }
    });
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      const z = Math.min(40, Math.max(0.05, cv.getZoom() * Math.exp(-dy * 0.0015)));
      const r = host.getBoundingClientRect();
      cv.zoomToPoint(new Point(e.clientX - r.left, e.clientY - r.top), z);
      setZoom(z);
    };
    host.addEventListener("wheel", wheel, { passive: false });
    const ro = new ResizeObserver(() => {
      cv.setDimensions({ width: host.clientWidth, height: host.clientHeight });
      cv.requestRenderAll();
    });
    ro.observe(host);

    loadDrawing(0);
    return () => {
      host.removeEventListener("wheel", wheel);
      ro.disconnect();
      cv.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === "Escape") applyTool("select");
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const shortcut: Record<string, Tool> = {
        s: "select",
        l: "line",
        r: "rect",
        e: "erase",
        p: "pan",
      };
      const t = shortcut[e.key.toLowerCase()];
      if (t) applyTool(t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, applyTool]);

  const handleFile = async (f: File) => {
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "dwg") {
      log("DWG binario: salvalo come DXF da AutoCAD/LibreCAD e riaprilo");
      return;
    }
    if (ext !== "dxf") {
      log(`Formato non supportato: .${ext}`);
      return;
    }
    setLoading("Lettura entità DXF…");
    try {
      const txt = await f.text();
      if (txt.startsWith("AutoCAD Binary DXF"))
        throw new Error("DXF binario non supportato, salva come DXF ASCII");
      await new Promise((r) => setTimeout(r, 30)); // let the loader paint
      const ents = parseDxf(txt);
      if (!ents.length) {
        log("Nessuna entità supportata nel file");
        return;
      }
      setLoading(`Disegno di ${ents.length} entità…`);
      await new Promise((r) => setTimeout(r, 30));
      setFileName(f.name);
      loadDrawing(ents);
      log(`${f.name}: ${ents.length} entità caricate`);
    } catch (err) {
      log(`Errore lettura DXF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(null);
    }
  };

  const exportDxf = () => {
    const cv = cvRef.current;
    if (!cv) return;
    setLoading("Generazione DXF sul server…");
    setTimeout(() => {
      const blob = new Blob([toDxf(layerRef.current.toEnts())], { type: "application/dxf" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName.replace(/\.(dwg|dxf)$/i, "") + "_modificato.dxf";
      a.click();
      URL.revokeObjectURL(a.href);
      setLoading(null);
      log("DXF esportato");
    }, 800);
  };

  const runCommand = (raw: string) => {
    const c = raw.trim().toLowerCase();
    if (!c) return;
    const col = PALETTE.find((p) => p.label.toLowerCase() === c);
    if (col) {
      setColor(col.value);
      log(`Colore: ${col.label}`);
    } else if (["canc", "cancella", "del", "delete", "elimina"].includes(c)) deleteSelected();
    else if (["linea", "line", "l"].includes(c)) {
      applyTool("line");
      log("Comando LINEA attivo");
    } else if (["rettangolo", "rett", "rect", "r"].includes(c)) {
      applyTool("rect");
      log("Comando RETTANGOLO attivo");
    } else if (["gomma", "erase", "e"].includes(c)) {
      applyTool("erase");
      log("GOMMA attiva: clicca o trascina sugli elementi");
    } else if (["pan", "mano", "p"].includes(c)) {
      applyTool("pan");
      log("Modalità PAN attiva");
    } else if (["sel", "seleziona", "s"].includes(c)) {
      applyTool("select");
      log("Modalità SELEZIONE");
    } else if (["ze", "zoom e", "estensione", "zoom estensione"].includes(c)) {
      zoomExtents();
      log("Zoom estensione");
    } else if (["z+", "zoom +", "zoom+"].includes(c)) {
      zoomBy(1.25);
      log("Zoom +");
    } else if (["z-", "zoom -", "zoom-"].includes(c)) {
      zoomBy(0.8);
      log("Zoom −");
    } else if (["esporta", "salva", "export"].includes(c)) exportDxf();
    else log(`Comando sconosciuto: "${raw}"`);
    setCmd("");
  };

  const tools: { id: Tool; icon: typeof Hand; label: string }[] = [
    { id: "select", icon: MousePointer2, label: "Seleziona / riquadro (S)" },
    { id: "erase", icon: Eraser, label: "Gomma: clicca o trascina per cancellare (E)" },
    { id: "line", icon: Minus, label: "Linea (L)" },
    { id: "rect", icon: Square, label: "Rettangolo (R)" },
  ];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* COMMAND LINE */}
      <header className="z-20 flex shrink-0 items-stretch border-b border-border bg-card">
        <div className="flex items-center gap-2 border-r border-border px-4">
          <div className="grid h-7 w-7 place-items-center rounded bg-primary font-mono text-xs font-bold text-primary-foreground">
            DW
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Pulizia DWG</div>
            <div className="max-w-40 truncate font-mono text-[11px] text-muted-foreground">
              {fileName}
            </div>
          </div>
        </div>
        <div className="flex flex-1 flex-col justify-center px-4 py-1.5 font-mono text-xs">
          {history.map((h, i) => (
            <div
              key={i}
              className={i === history.length - 1 ? "text-foreground" : "text-muted-foreground"}
            >
              › {h}
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runCommand(cmd);
            }}
            className="mt-0.5 flex items-center gap-2"
          >
            <Terminal className="h-3.5 w-3.5 text-primary" />
            <span className="text-primary">Comando:</span>
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder="linea, rett, gomma, canc, pan, ze, rosso…"
              className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
              aria-label="Linea di comando"
            />
          </form>
        </div>
        <div className="flex items-center gap-2 border-l border-border px-4">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
            <Upload className="h-4 w-4" /> Carica DXF
            <input
              type="file"
              accept=".dxf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </label>
          <button
            onClick={exportDxf}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download className="h-4 w-4" /> Esporta DXF
          </button>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* EDIT TOOLBAR */}
        <aside className="z-10 flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-3">
          {tools.map((t) => (
            <button
              key={t.id}
              title={t.label}
              aria-label={t.label}
              onClick={() => applyTool(t.id)}
              className={`grid h-11 w-11 place-items-center rounded-md transition-colors ${tool === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
            >
              <t.icon className="h-5 w-5" />
            </button>
          ))}
          <button
            title="Elimina (Canc)"
            aria-label="Elimina"
            onClick={deleteSelected}
            className="grid h-11 w-11 place-items-center rounded-md text-destructive hover:bg-destructive/15"
          >
            <Trash2 className="h-5 w-5" />
          </button>
          <div className="my-2 h-px w-8 bg-border" />
          {PALETTE.map((p) => (
            <button
              key={p.value}
              title={p.label}
              aria-label={`Colore ${p.label}`}
              onClick={() => {
                setColor(p.value);
                log(`Colore: ${p.label}`);
              }}
              className={`h-8 w-8 rounded-full border-2 transition-transform ${color === p.value ? "scale-110 border-primary ring-2 ring-primary/40" : "border-border"}`}
              style={{ backgroundColor: p.swatch }}
            />
          ))}
        </aside>

        {/* CANVAS */}
        <main
          ref={hostRef}
          className="cad-grid relative flex-1 overflow-hidden"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
        >
          <canvas ref={elRef} />

          {dragOver && (
            <div className="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/70">
              <div className="text-center">
                <Upload className="mx-auto mb-2 h-10 w-10 text-primary" />
                <p className="font-medium">Rilascia il file .DWG o .DXF</p>
              </div>
            </div>
          )}
          {loading && (
            <div className="absolute inset-0 z-30 grid place-items-center bg-background/80 backdrop-blur-sm">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-5 py-4 font-mono text-sm">
                <Loader2 className="h-5 w-5 animate-spin text-primary" /> {loading}
              </div>
            </div>
          )}

          {/* NAV CONTROLS (right side) */}
          <div className="absolute right-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-lg">
            {[
              { icon: ZoomIn, label: "Zoom +", on: () => zoomBy(1.25), active: false },
              { icon: ZoomOut, label: "Zoom −", on: () => zoomBy(0.8), active: false },
              {
                icon: Maximize,
                label: "Zoom estensione",
                on: () => {
                  zoomExtents();
                  log("Zoom estensione");
                },
                active: false,
              },
              {
                icon: Hand,
                label: "Pan (mano)",
                on: () => applyTool(tool === "pan" ? "select" : "pan"),
                active: tool === "pan",
              },
            ].map((b) => (
              <button
                key={b.label}
                title={b.label}
                aria-label={b.label}
                onClick={b.on}
                className={`grid h-10 w-10 place-items-center rounded-md ${b.active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"}`}
              >
                <b.icon className="h-5 w-5" />
              </button>
            ))}
          </div>

          <div className="absolute bottom-3 left-3 z-10 rounded border border-border bg-card/90 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {tool.toUpperCase()} · zoom {(zoom * 100).toFixed(0)}% · trascina un file per aprirlo ·
            rotella = zoom
          </div>
        </main>
      </div>
    </div>
  );
}
