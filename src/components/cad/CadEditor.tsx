import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas, Line, Rect, FabricText, Point, type FabricObject } from "fabric";
import {
  MousePointer2, Hand, Minus, Square, Trash2, ZoomIn, ZoomOut, Maximize, Upload, Download, Loader2, Terminal,
} from "lucide-react";
import { PALETTE, buildMockDrawing, toDxf, type Tool } from "./cad-data";

const lock = { lockMovementX: true, lockMovementY: true, hasControls: false, hoverCursor: "pointer" };

export default function CadEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLCanvasElement>(null);
  const cvRef = useRef<Canvas | null>(null);
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
  useEffect(() => { colorRef.current = color; }, [color]);

  const applyTool = useCallback((t: Tool) => {
    toolRef.current = t;
    setTool(t);
    const cv = cvRef.current;
    if (!cv) return;
    cv.selection = false;
    cv.discardActiveObject();
    cv.defaultCursor = t === "pan" ? "grab" : t === "select" ? "default" : "crosshair";
    cv.forEachObject((o) => { o.selectable = t === "select"; o.evented = t === "select"; });
    cv.requestRenderAll();
  }, []);

  const zoomExtents = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const objs = cv.getObjects();
    cv.setViewportTransform([1, 0, 0, 1, 0, 0]);
    if (!objs.length) { setZoom(1); return; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    objs.forEach((o) => {
      const r = o.getBoundingRect();
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
      x2 = Math.max(x2, r.left + r.width); y2 = Math.max(y2, r.top + r.height);
    });
    const pad = 60, W = cv.getWidth(), H = cv.getHeight();
    const z = Math.min((W - pad * 2) / (x2 - x1), (H - pad * 2) / (y2 - y1));
    cv.setViewportTransform([z, 0, 0, z, (W - (x2 - x1) * z) / 2 - x1 * z, (H - (y2 - y1) * z) / 2 - y1 * z]);
    setZoom(z);
  }, []);

  const zoomBy = useCallback((f: number) => {
    const cv = cvRef.current;
    if (!cv) return;
    const z = Math.min(40, Math.max(0.05, cv.getZoom() * f));
    cv.zoomToPoint(new Point(cv.getWidth() / 2, cv.getHeight() / 2), z);
    setZoom(z);
  }, []);

  const loadDrawing = useCallback((variant: number) => {
    const cv = cvRef.current;
    if (!cv) return;
    cv.clear();
    buildMockDrawing(variant).forEach((e) => {
      let o: FabricObject;
      if (e.type === "line") o = new Line([e.x1, e.y1, e.x2, e.y2], { stroke: e.color, strokeWidth: e.w ?? 1.5, strokeUniform: true, ...lock });
      else if (e.type === "rect") o = new Rect({ left: e.x, top: e.y, width: e.w, height: e.h, fill: "transparent", stroke: e.color, strokeWidth: e.sw ?? 1.5, strokeUniform: true, ...lock });
      else o = new FabricText(e.text, { left: e.x, top: e.y, fontSize: e.size, fill: e.color, fontFamily: "JetBrains Mono, monospace", angle: e.angle ?? 0, ...lock });
      cv.add(o);
    });
    applyTool(toolRef.current);
    zoomExtents();
  }, [applyTool, zoomExtents]);

  const deleteSelected = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const sel = cv.getActiveObjects();
    if (!sel.length) { log("Nessun elemento selezionato"); return; }
    sel.forEach((o) => cv.remove(o));
    cv.discardActiveObject();
    cv.requestRenderAll();
    log(sel.length > 1 ? `${sel.length} elementi eliminati` : "Elemento eliminato");
  }, [log]);

  // init canvas
  useEffect(() => {
    const host = hostRef.current!, el = elRef.current!;
    const cv = new Canvas(el, { width: host.clientWidth, height: host.clientHeight, selection: false, backgroundColor: "transparent", selectionColor: "rgba(80,160,255,0.15)" });
    cvRef.current = cv;
    FabricObject_style(cv);

    let drawing: FabricObject | null = null, start: Point | null = null, panning = false, last = { x: 0, y: 0 };

    cv.on("mouse:down", (opt) => {
      const t = toolRef.current;
      const ev = opt.e as MouseEvent;
      if (t === "pan" || ev.button === 1) {
        panning = true; last = { x: ev.clientX, y: ev.clientY }; cv.setCursor("grabbing"); return;
      }
      if (t === "line" || t === "rect") {
        start = cv.getScenePoint(ev);
        const c = colorRef.current;
        drawing = t === "line"
          ? new Line([start.x, start.y, start.x, start.y], { stroke: c, strokeWidth: 2, strokeUniform: true, ...lock, selectable: false, evented: false })
          : new Rect({ left: start.x, top: start.y, width: 0, height: 0, fill: "transparent", stroke: c, strokeWidth: 2, strokeUniform: true, ...lock, selectable: false, evented: false });
        cv.add(drawing);
      }
    });
    cv.on("mouse:move", (opt) => {
      const ev = opt.e as MouseEvent;
      if (panning) {
        const vpt = cv.viewportTransform!;
        vpt[4] += ev.clientX - last.x; vpt[5] += ev.clientY - last.y;
        last = { x: ev.clientX, y: ev.clientY };
        cv.setViewportTransform(vpt); return;
      }
      if (!drawing || !start) return;
      const p = cv.getScenePoint(ev);
      if (drawing instanceof Line) drawing.set({ x2: p.x, y2: p.y });
      else drawing.set({ left: Math.min(p.x, start.x), top: Math.min(p.y, start.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) });
      drawing.setCoords();
      cv.requestRenderAll();
    });
    cv.on("mouse:up", () => {
      if (panning) { panning = false; cv.setCursor(toolRef.current === "pan" ? "grab" : "default"); return; }
      if (drawing) {
        const tiny = drawing instanceof Line
          ? Math.hypot(drawing.x2! - drawing.x1!, drawing.y2! - drawing.y1!) < 2
          : drawing.width! < 2 || drawing.height! < 2;
        if (tiny) cv.remove(drawing);
        else log(drawing instanceof Line ? "Linea creata" : "Rettangolo creato");
        drawing = null; start = null;
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
    const ro = new ResizeObserver(() => { cv.setDimensions({ width: host.clientWidth, height: host.clientHeight }); });
    ro.observe(host);

    loadDrawing(0);
    return () => { host.removeEventListener("wheel", wheel); ro.disconnect(); cv.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
      if (e.key === "Escape") applyTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, applyTool]);

  const handleFile = (f: File) => {
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext !== "dwg" && ext !== "dxf") { log(`Formato non supportato: .${ext}`); return; }
    setFileName(f.name);
    setLoading(`Conversione ${ext.toUpperCase()} → SVG sul server…`);
    setTimeout(() => setLoading("Vettorializzazione entità…"), 900);
    setTimeout(() => { setLoading(null); loadDrawing(1); log(`File ${f.name} caricato`); }, 2000);
  };

  const exportDxf = () => {
    const cv = cvRef.current;
    if (!cv) return;
    setLoading("Generazione DXF sul server…");
    setTimeout(() => {
      const blob = new Blob([toDxf(cv.getObjects())], { type: "application/dxf" });
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
    if (col) { setColor(col.value); log(`Colore: ${col.label}`); }
    else if (["canc", "cancella", "del", "delete", "elimina"].includes(c)) deleteSelected();
    else if (["linea", "line", "l"].includes(c)) { applyTool("line"); log("Comando LINEA attivo"); }
    else if (["rettangolo", "rett", "rect", "r"].includes(c)) { applyTool("rect"); log("Comando RETTANGOLO attivo"); }
    else if (["pan", "mano", "p"].includes(c)) { applyTool("pan"); log("Modalità PAN attiva"); }
    else if (["sel", "seleziona", "s"].includes(c)) { applyTool("select"); log("Modalità SELEZIONE"); }
    else if (["ze", "zoom e", "estensione", "zoom estensione"].includes(c)) { zoomExtents(); log("Zoom estensione"); }
    else if (["z+", "zoom +", "zoom+"].includes(c)) { zoomBy(1.25); log("Zoom +"); }
    else if (["z-", "zoom -", "zoom-"].includes(c)) { zoomBy(0.8); log("Zoom −"); }
    else if (["esporta", "salva", "export"].includes(c)) exportDxf();
    else log(`Comando sconosciuto: "${raw}"`);
    setCmd("");
  };

  const tools: { id: Tool; icon: typeof Hand; label: string }[] = [
    { id: "select", icon: MousePointer2, label: "Seleziona (S)" },
    { id: "line", icon: Minus, label: "Linea (L)" },
    { id: "rect", icon: Square, label: "Rettangolo (R)" },
  ];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* COMMAND LINE */}
      <header className="z-20 flex shrink-0 items-stretch border-b border-border bg-card">
        <div className="flex items-center gap-2 border-r border-border px-4">
          <div className="grid h-7 w-7 place-items-center rounded bg-primary font-mono text-xs font-bold text-primary-foreground">DW</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Pulizia DWG</div>
            <div className="max-w-40 truncate font-mono text-[11px] text-muted-foreground">{fileName}</div>
          </div>
        </div>
        <div className="flex flex-1 flex-col justify-center px-4 py-1.5 font-mono text-xs">
          {history.map((h, i) => (
            <div key={i} className={i === history.length - 1 ? "text-foreground" : "text-muted-foreground"}>› {h}</div>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); runCommand(cmd); }} className="mt-0.5 flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-primary" />
            <span className="text-primary">Comando:</span>
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="linea, rett, canc, pan, ze, rosso…"
              className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60" aria-label="Linea di comando" />
          </form>
        </div>
        <div className="flex items-center gap-2 border-l border-border px-4">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
            <Upload className="h-4 w-4" /> Apri
            <input type="file" accept=".dwg,.dxf" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
          </label>
          <button onClick={exportDxf} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Download className="h-4 w-4" /> Esporta DXF
          </button>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* EDIT TOOLBAR */}
        <aside className="z-10 flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-3">
          {tools.map((t) => (
            <button key={t.id} title={t.label} aria-label={t.label} onClick={() => applyTool(t.id)}
              className={`grid h-11 w-11 place-items-center rounded-md transition-colors ${tool === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
              <t.icon className="h-5 w-5" />
            </button>
          ))}
          <button title="Elimina (Canc)" aria-label="Elimina" onClick={deleteSelected}
            className="grid h-11 w-11 place-items-center rounded-md text-destructive hover:bg-destructive/15">
            <Trash2 className="h-5 w-5" />
          </button>
          <div className="my-2 h-px w-8 bg-border" />
          {PALETTE.map((p) => (
            <button key={p.value} title={p.label} aria-label={`Colore ${p.label}`} onClick={() => { setColor(p.value); log(`Colore: ${p.label}`); }}
              className={`h-8 w-8 rounded-full border-2 transition-transform ${color === p.value ? "scale-110 border-primary ring-2 ring-primary/40" : "border-border"}`}
              style={{ backgroundColor: p.swatch }} />
          ))}
        </aside>

        {/* CANVAS */}
        <main ref={hostRef} className="cad-grid relative flex-1 overflow-hidden"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
          <canvas ref={elRef} />

          {dragOver && (
            <div className="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/70">
              <div className="text-center"><Upload className="mx-auto mb-2 h-10 w-10 text-primary" /><p className="font-medium">Rilascia il file .DWG o .DXF</p></div>
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
              { icon: Maximize, label: "Zoom estensione", on: () => { zoomExtents(); log("Zoom estensione"); }, active: false },
              { icon: Hand, label: "Pan (mano)", on: () => applyTool(tool === "pan" ? "select" : "pan"), active: tool === "pan" },
            ].map((b) => (
              <button key={b.label} title={b.label} aria-label={b.label} onClick={b.on}
                className={`grid h-10 w-10 place-items-center rounded-md ${b.active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"}`}>
                <b.icon className="h-5 w-5" />
              </button>
            ))}
          </div>

          <div className="absolute bottom-3 left-3 z-10 rounded border border-border bg-card/90 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {tool.toUpperCase()} · zoom {(zoom * 100).toFixed(0)}% · trascina un file per aprirlo · rotella = zoom
          </div>
        </main>
      </div>
    </div>
  );
}

function FabricObject_style(_cv: Canvas) {
  // selection highlight
  Rect.ownDefaults.borderColor = Line.ownDefaults.borderColor = FabricText.ownDefaults.borderColor = "#3b9cff";
  Rect.ownDefaults.borderScaleFactor = Line.ownDefaults.borderScaleFactor = FabricText.ownDefaults.borderScaleFactor = 2;
  Rect.ownDefaults.padding = Line.ownDefaults.padding = FabricText.ownDefaults.padding = 4;
}
