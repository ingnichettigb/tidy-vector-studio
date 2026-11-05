/**
 * =======================================================================
 * File:        CadEditor.tsx
 * Percorso:    (src/components/cad/CadEditor.tsx)
 * Revisione:   Rev. 1.1
 * Data:        05/11/2026
 * -----------------------------------------------------------------------
 * Storico Revisioni (max 10 voci, oltre la decima si sostituisce la più vecchia):
 * [02/11/2026] Rev. 1.0 - Editor CAD: linea comandi, strumenti, foglio A4, numeri, progetto
 * [05/11/2026] Rev. 1.1 - Apertura dei file .dwg (dwg-import) e pulsante "Scarica come DXF"
 *                         (dxf-blocks-export). Solo aggiunte: i flussi esistenti non cambiano.
 * =======================================================================
 */
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Canvas, Line, Rect, Point, type FabricObject } from "fabric";
import {
  MousePointer2,
  Hand,
  Minus,
  Square,
  Eraser,
  Scissors,
  Split,
  Frame,
  Save,
  Eye,
  Lock,
  LockOpen,
  EyeOff,
  Move,
  Copy,
  ClipboardPaste,
  Trash2,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Upload,
  Download,
  FileDown,
  ImageDown,
  Loader2,
  Terminal,
} from "lucide-react";
import {
  DEFAULT_THICKNESS,
  DOT_FACTOR,
  MARKER_MM,
  PALETTE,
  THICKNESS,
  A4_MM,
  buildMockDrawing,
  fitSheet,
  sheetRatio,
  sheetUnitsPerMm,
  toDxf,
  type Tool,
  type Ent,
  type Sheet,
} from "./cad-data";
import { DrawingLayer } from "./drawing-layer";
import { parseDxf } from "./dxf-import";
import { parseDwg } from "./dwg-import";
import { drawingToDxf } from "./dxf-blocks-export";
import { buildProject, parseProject } from "./project-file";
import { cleanFileName, downloadBlob, pickFileToOpen, saveWithPicker } from "./save-file";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Rubber-band preview shown while drawing a new line/rectangle (the finished shape is
// committed to the DrawingLayer on mouse up).
const previewProps = {
  selectable: false,
  evented: false,
  hasControls: false,
  strokeUniform: true,
};

// Radius of a circled number as seen on screen when it is placed (stored in drawing units).
const MARKER_RADIUS_PX = { S: 11, M: 15, L: 21 } as const;
type MarkerSize = keyof typeof MARKER_RADIUS_PX;

function MarkerIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9.5" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        fontFamily="monospace"
      >
        01
      </text>
    </svg>
  );
}

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
  // nome del DWG aperto: il pulsante "Scarica come DXF" compare solo finché è il file in uso
  const [dwgName, setDwgName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [zoom, setZoom] = useState(1);
  // line thickness for new shapes, and for the selection when it is changed (screen px)
  const [thickness, setThickness] = useState(DEFAULT_THICKNESS);
  const thickRef = useRef(DEFAULT_THICKNESS);
  // circled numbers: next number to place (00, 01, 02…) and size
  const [markerNext, setMarkerNextState] = useState(0);
  const markerNextRef = useRef(0);
  const [markerSize, setMarkerSizeState] = useState<MarkerSize>("M");
  const markerSizeRef = useRef<MarkerSize>("M");
  const setMarkerNext = useCallback((n: number) => {
    const v = Math.max(0, Math.floor(n) || 0);
    markerNextRef.current = v;
    setMarkerNextState(v);
  }, []);
  // copy / paste: what was copied, and how many times it has been pasted (offset grows each time)
  const clipRef = useRef<{ ents: Ent[]; pastes: number } | null>(null);
  // the circled number currently selected on its own: its number can be changed from the top bar
  const [editMarker, setEditMarker] = useState<{ i: number; n: string } | null>(null);
  // A4 export frame (scene coordinates); lives only on screen, never in the DXF
  const sheetRef = useRef<Sheet | null>(null);
  const [sheetOn, setSheetOn] = useState(false);
  const [sheetLand, setSheetLand] = useState(false);
  // a fixed frame cannot be dragged by accident: zoom and pan stay free while numbers are placed
  const sheetLockedRef = useRef(false);
  const [sheetLocked, setSheetLocked] = useState(false);
  // export only the entities the frame was fitted to (set by "Foglio sulla selezione")
  const onlyRef = useRef<number[] | null>(null);
  const [onlyCount, setOnlyCount] = useState(0);
  const [onlyChecked, setOnlyChecked] = useState(true);
  // the "Numeri" layer: off hides the circled numbers (screen, PNG exports, DXF layer)
  const [numbersHidden, setNumbersHidden] = useState(false);
  const [hist, setHist] = useState({ undo: false, redo: false });
  // where the open drawing came from (lets the save window start in the same folder)
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // shown when the browser cannot let the user choose the folder: explains, waits for OK
  const [saveNotice, setSaveNotice] = useState<{
    blob: Blob;
    name: string;
    ext: string;
    label: string;
  } | null>(null);

  const log = useCallback((m: string) => setHistory((h) => [...h, m].slice(-3)), []);
  const syncHist = useCallback(
    () => setHist({ undo: layerRef.current.canUndo, redo: layerRef.current.canRedo }),
    [],
  );
  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  const syncMarker = useCallback(() => {
    const L = layerRef.current;
    const only = L.selected.size === 1 ? [...L.selected][0]! : -1;
    const e = only >= 0 ? L.items[only] : null;
    setEditMarker(e && e.type === "marker" ? { i: only, n: e.n } : null);
  }, []);

  /**
   * While the A4 frame is on, every circled number takes the size it will have on the paper
   * (S / M / L in mm). Where it was clicked is kept; only the size follows the frame.
   */
  const syncMarkerSize = useCallback(() => {
    const sh = sheetRef.current;
    if (!sh) return;
    layerRef.current.setMarkersRadius(
      MARKER_MM[markerSizeRef.current] * sheetUnitsPerMm(sh),
      false,
    );
    cvRef.current?.requestRenderAll();
  }, []);

  /** Put the A4 frame around the whole drawing. */
  const placeSheet = useCallback(
    (land: boolean, around?: ReturnType<DrawingLayer["bounds"]>, only?: number[]) => {
      const b = around ?? layerRef.current.bounds();
      if (!b) {
        log("Disegno vuoto: niente da inquadrare");
        return false;
      }
      const sh = fitSheet(b, land, around ? 0.1 : 0.06);
      sheetRef.current = sh;
      onlyRef.current = only ?? null;
      setOnlyCount(only?.length ?? 0);
      syncMarkerSize();
      // zoom so the whole sheet is visible
      const cv = cvRef.current;
      if (cv) {
        const pad = 70;
        const z = Math.min((cv.getWidth() - pad * 2) / sh.w, (cv.getHeight() - pad * 2) / sh.h);
        cv.setViewportTransform([
          z,
          0,
          0,
          z,
          (cv.getWidth() - sh.w * z) / 2 - sh.x * z,
          (cv.getHeight() - sh.h * z) / 2 - sh.y * z,
        ]);
        setZoom(z);
        cv.requestRenderAll();
      }
      return true;
    },
    [log, syncMarkerSize],
  );

  const toggleSheet = useCallback(() => {
    if (sheetRef.current) {
      sheetRef.current = null;
      onlyRef.current = null;
      sheetLockedRef.current = false;
      setSheetLocked(false);
      setOnlyCount(0);
      setSheetOn(false);
      cvRef.current?.requestRenderAll();
      log("Foglio A4 nascosto");
    } else if (placeSheet(sheetLand)) {
      setSheetOn(true);
      log("Foglio A4: trascinalo dal bordo o dall'etichetta, allargalo dagli angoli");
    }
  }, [log, placeSheet, sheetLand]);

  /** Fit the A4 frame around what is selected, centred; the export then holds just that. */
  const sheetOnSelection = useCallback(() => {
    const L = layerRef.current;
    const b = L.selectionBounds();
    if (!b) {
      log("Prima seleziona la parte da esportare");
      return;
    }
    const idx = [...L.selected];
    if (placeSheet(sheetLand, b, idx)) {
      setSheetOn(true);
      setOnlyChecked(true);
      log(`Foglio A4 sulla selezione (${idx.length} element${idx.length === 1 ? "o" : "i"})`);
    }
  }, [log, placeSheet, sheetLand]);

  const setNumbersVisible = useCallback(
    (visible: boolean) => {
      layerRef.current.setMarkersVisible(visible);
      setNumbersHidden(!visible);
      syncMarker();
      cvRef.current?.requestRenderAll();
      log(
        visible ? "Livello Numeri acceso" : "Livello Numeri spento: non si vede e non si esporta",
      );
    },
    [log, syncMarker],
  );

  /** Turn the frame around keeping its centre and its scale (paper mm per drawing unit). */
  const chooseOrientation = useCallback(
    (land: boolean) => {
      setSheetLand(land);
      const sh = sheetRef.current;
      if (!sh || sh.land === land) return;
      const upm = sheetUnitsPerMm(sh);
      const w = upm * (land ? A4_MM.long : A4_MM.short);
      const h = w / sheetRatio(land);
      sheetRef.current = { x: sh.x + sh.w / 2 - w / 2, y: sh.y + sh.h / 2 - h / 2, w, h, land };
      syncMarkerSize();
      cvRef.current?.requestRenderAll();
    },
    [syncMarkerSize],
  );

  const toggleLock = useCallback(() => {
    const v = !sheetLockedRef.current;
    sheetLockedRef.current = v;
    setSheetLocked(v);
    cvRef.current?.requestRenderAll();
    log(
      v
        ? "Foglio fissato: puoi ingrandire e inserire i numeri, il foglio non si sposta"
        : "Foglio sbloccato: puoi spostarlo e ridimensionarlo",
    );
  }, [log]);

  /** Write a new number into a circled number; `done` also drops the selection highlight. */
  const applyMarkerNumber = useCallback(
    (i: number, raw: string, done: boolean) => {
      const v = raw.trim();
      const L = layerRef.current;
      if (v && L.setMarkerNumber(i, v)) {
        syncHist();
        log(`Numero cambiato in ${v}`);
      }
      if (done) L.selected.clear();
      cvRef.current?.requestRenderAll();
      syncMarker();
    },
    [log, syncHist, syncMarker],
  );

  const applyTool = useCallback((t: Tool) => {
    toolRef.current = t;
    setTool(t);
    setEditMarker(null);
    const cv = cvRef.current;
    if (!cv) return;
    layerRef.current.selected.clear();
    cv.defaultCursor =
      t === "pan" ? "grab" : t === "select" ? "default" : t === "move" ? "move" : "crosshair";
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
      // a new drawing starts with every layer on and no export frame
      setNumbersHidden(false);
      sheetLockedRef.current = false;
      setSheetLocked(false);
      sheetRef.current = null;
      onlyRef.current = null;
      setOnlyCount(0);
      setSheetOn(false);
      setEditMarker(null);
      zoomExtents();
      syncHist();
      cv.requestRenderAll();
    },
    [zoomExtents, syncHist],
  );

  const explodeSelected = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const n = layerRef.current.explodeSelected();
    if (!n) {
      log("Esplodi: seleziona prima una polilinea o un rettangolo");
      return;
    }
    cv.requestRenderAll();
    syncHist();
    log(n > 1 ? `${n} polilinee esplose in linee` : "Polilinea esplosa in linee");
  }, [log, syncHist]);

  const deleteSelected = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const n = layerRef.current.removeSelected();
    if (!n) {
      log("Nessun elemento selezionato");
      return;
    }
    cv.requestRenderAll();
    syncHist();
    syncMarker();
    log(n > 1 ? `${n} elementi eliminati` : "Elemento eliminato");
  }, [log, syncHist, syncMarker]);

  const copySelected = useCallback(() => {
    const ents = layerRef.current.copySelected();
    if (!ents.length) {
      log("Niente da copiare: seleziona degli elementi");
      return;
    }
    clipRef.current = { ents, pastes: 0 };
    log(ents.length === 1 ? "1 elemento copiato" : `${ents.length} elementi copiati`);
  }, [log]);

  const pasteClipboard = useCallback(() => {
    const cv = cvRef.current;
    const clip = clipRef.current;
    if (!cv || !clip) {
      log("Niente da incollare: prima copia (Ctrl+C)");
      return;
    }
    // each paste lands a bit further (~24 px on screen) so copies don't hide each other
    clip.pastes++;
    const off = (24 * clip.pastes) / cv.getZoom();
    const n = layerRef.current.paste(clip.ents, off, off);
    cv.requestRenderAll();
    syncHist();
    syncMarker();
    log(n === 1 ? "1 elemento incollato" : `${n} elementi incollati`);
  }, [log, syncHist, syncMarker]);

  const undo = useCallback(() => {
    const r = layerRef.current.undo();
    if (!r) {
      log("Niente da annullare");
      return;
    }
    syncMarkerSize();
    cvRef.current?.requestRenderAll();
    syncHist();
    syncMarker();
    const msg: Record<string, string> = {
      remove: `Annullata eliminazione (${r.n})`,
      width: `Annullata modifica spessore (${r.n})`,
      trim: "Annullato taglio",
      move: "Annullato spostamento",
      edit: "Annullata modifica dei numeri",
      add: "Annullato inserimento",
    };
    log(msg[r.kind]!);
  }, [log, syncHist, syncMarker, syncMarkerSize]);

  const redo = useCallback(() => {
    const r = layerRef.current.redo();
    if (!r) {
      log("Niente da ripristinare");
      return;
    }
    syncMarkerSize();
    cvRef.current?.requestRenderAll();
    syncHist();
    syncMarker();
    const msg: Record<string, string> = {
      remove: `Rifatta eliminazione (${r.n})`,
      width: `Rifatta modifica spessore (${r.n})`,
      trim: "Rifatto taglio",
      move: "Rifatto spostamento",
      edit: "Rifatta modifica dei numeri",
      add: "Rifatto inserimento",
    };
    log(msg[r.kind]!);
  }, [log, syncHist, syncMarker, syncMarkerSize]);

  const chooseThickness = useCallback(
    (px: number) => {
      thickRef.current = px;
      setThickness(px);
      const n = layerRef.current.setSelectedWidth(px);
      if (n) {
        cvRef.current?.requestRenderAll();
        syncHist();
        log(`Spessore ${px} applicato a ${n} element${n === 1 ? "o" : "i"}`);
      } else log(`Spessore ${px}`);
    },
    [log, syncHist],
  );

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
      sheetDrag: { mode: "move" | "resize"; ax: number; ay: number } | null = null,
      moving: {
        x: number;
        y: number;
        dx: number;
        dy: number;
        idx: number[];
        keep: boolean; // a lone number moves without its pointed-at spot
        target?: { from: Ent }; // dragging the dot of a number, not the number
      } | null = null,
      // number tool: press on the spot to point at, drag to where the number goes
      markerDrag: { x0: number; y0: number; x: number; y: number } | null = null,
      erasedIdx: number[] = [],
      marquee: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        hit: number;
        shift: boolean;
      } | null = null,
      last = { x: 0, y: 0 };

    // A4 frame: dims what is outside, dashed outline, corner handles, "move" tab on the top edge
    const sheetScreen = (sh: Sheet) => {
      const v = cv.viewportTransform!;
      const z = v[0]!;
      return {
        sx: sh.x * z + v[4]!,
        sy: sh.y * z + v[5]!,
        ex: (sh.x + sh.w) * z + v[4]!,
        ey: (sh.y + sh.h) * z + v[5]!,
      };
    };
    const drawSheet = (ctx: CanvasRenderingContext2D) => {
      const sh = sheetRef.current;
      if (!sh) return;
      const { sx, sy, ex, ey } = sheetScreen(sh);
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.07)";
      ctx.beginPath();
      ctx.rect(0, 0, cv.getWidth(), cv.getHeight());
      ctx.rect(sx, sy, ex - sx, ey - sy);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(sx, sy, ex - sx, ey - sy);
      ctx.setLineDash([]);
      if (sheetLockedRef.current) {
        ctx.restore();
        return; // fixed: just the outline, no handles
      }
      ctx.fillStyle = "#fff";
      for (const [cx, cy] of [
        [sx, sy],
        [ex, sy],
        [ex, ey],
        [sx, ey],
      ] as const) {
        ctx.fillRect(cx - 5, cy - 5, 10, 10);
        ctx.strokeRect(cx - 5, cy - 5, 10, 10);
      }
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(sx, sy - 22, 92, 20);
      ctx.fillStyle = "#111";
      ctx.font = "bold 11px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillText("A4 · sposta", sx + 8, sy - 12);
      ctx.restore();
    };
    /** What is under a screen point of the A4 frame: a corner (resize) or the tab / edge (move). */
    const sheetHit = (vx: number, vy: number) => {
      const sh = sheetRef.current;
      if (!sh || sheetLockedRef.current) return null;
      const { sx, sy, ex, ey } = sheetScreen(sh);
      const corners = [
        [sx, sy],
        [ex, sy],
        [ex, ey],
        [sx, ey],
      ] as const;
      for (let k = 0; k < 4; k++) {
        const [cx, cy] = corners[k]!;
        if (Math.abs(vx - cx) <= 9 && Math.abs(vy - cy) <= 9) {
          const [ox, oy] = corners[(k + 2) % 4]!;
          const v = cv.viewportTransform!;
          return { mode: "resize" as const, ax: (ox - v[4]!) / v[0]!, ay: (oy - v[5]!) / v[0]! };
        }
      }
      const inTab = vx >= sx && vx <= sx + 92 && vy >= sy - 22 && vy <= sy;
      const onEdge =
        (Math.abs(vx - sx) <= 5 || Math.abs(vx - ex) <= 5) && vy >= sy && vy <= ey
          ? true
          : (Math.abs(vy - sy) <= 5 || Math.abs(vy - ey) <= 5) && vx >= sx && vx <= ex;
      return inTab || onEdge ? { mode: "move" as const, ax: 0, ay: 0 } : null;
    };

    // while dragging with the number tool: the spot, the leader line and where the number lands
    const drawMarkerPreview = (ctx: CanvasRenderingContext2D) => {
      const m = markerDrag;
      if (!m) return;
      const v = cv.viewportTransform!;
      const z = v[0]!;
      const [x0, y0, x1, y1] = [
        m.x0 * z + v[4]!,
        m.y0 * z + v[5]!,
        m.x * z + v[4]!,
        m.y * z + v[5]!,
      ];
      if (Math.hypot(x1 - x0, y1 - y0) <= 6) return;
      const r = markerRadius() * z;
      const d = Math.hypot(x1 - x0, y1 - y0);
      ctx.save();
      ctx.strokeStyle = colorRef.current;
      ctx.fillStyle = colorRef.current;
      ctx.lineWidth = Math.max(1, thickRef.current);
      ctx.globalAlpha = 0.75;
      if (d > r) {
        ctx.beginPath();
        ctx.moveTo(x1 + ((x0 - x1) / d) * r, y1 + ((y0 - y1) / d) * r);
        ctx.lineTo(x0, y0);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x0, y0, Math.max(r * DOT_FACTOR, 2.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x1, y1, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };

    // The drawing is painted by the DrawingLayer under Fabric's own objects (the preview),
    // selection highlight and rubber-band box on top.
    cv.on("before:render", ({ ctx }) =>
      layerRef.current.draw(ctx, cv.viewportTransform, cv.getWidth(), cv.getHeight()),
    );
    cv.on("after:render", ({ ctx }) => {
      layerRef.current.drawSelection(ctx, cv.viewportTransform);
      drawSheet(ctx);
      if (markerDrag) drawMarkerPreview(ctx);
      if (marquee) {
        const x = Math.min(marquee.x0, marquee.x1),
          y = Math.min(marquee.y0, marquee.y1);
        ctx.save();
        // left -> right: window (only what is fully inside); right -> left: crossing (touched too)
        const crossing = marquee.x1 < marquee.x0;
        ctx.fillStyle = crossing ? "rgba(61,220,132,0.15)" : "rgba(80,160,255,0.15)";
        ctx.strokeStyle = crossing ? "#3ddc84" : "#3b9cff";
        ctx.setLineDash(crossing ? [6, 4] : []);
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
        erasedIdx.push(i);
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

    const markerRadius = () =>
      sheetRef.current
        ? MARKER_MM[markerSizeRef.current] * sheetUnitsPerMm(sheetRef.current)
        : MARKER_RADIUS_PX[markerSizeRef.current] / cv.getZoom();

    /** Put a circled number at (x, y); with (tx, ty) it gets a leader line to that spot. */
    const placeMarker = (x: number, y: number, tx?: number, ty?: number) => {
      if (layerRef.current.hideMarkers) setNumbersVisible(true); // a new number needs its layer on
      const n = String(markerNextRef.current).padStart(2, "0");
      layerRef.current.addUndoable({
        type: "marker",
        x,
        y,
        r: markerRadius(),
        n,
        color: colorRef.current,
        w: thickRef.current,
        ...(tx !== undefined && ty !== undefined ? { tx, ty } : {}),
      });
      setMarkerNext(markerNextRef.current + 1);
      syncHist();
      cv.requestRenderAll();
      log(tx !== undefined ? `Numero ${n} inserito con linea` : `Numero ${n} inserito`);
    };

    cv.on("mouse:down", (opt) => {
      const t = toolRef.current;
      const ev = opt.e as MouseEvent;
      if (sheetRef.current && ev.button === 0 && t !== "pan") {
        const v = cv.getViewportPoint(ev);
        const hit = sheetHit(v.x, v.y);
        if (hit) {
          sheetDrag = hit;
          const p = cv.getScenePoint(ev);
          if (hit.mode === "move") {
            // remember where inside the frame it was grabbed
            sheetDrag.ax = p.x - sheetRef.current.x;
            sheetDrag.ay = p.y - sheetRef.current.y;
          }
          return;
        }
      }
      if (t === "erase" && ev.button !== 1) {
        erasing = true;
        erasedIdx = [];
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
      if (t === "move") {
        // drag an element (or the whole selection, when the element is part of it);
        // the dot of a number's leader line is dragged on its own
        const p = cv.getScenePoint(ev);
        const L = layerRef.current;
        const dot = L.hitTarget(p.x, p.y, 8 / cv.getZoom());
        if (dot >= 0) {
          L.selected.clear();
          L.selected.add(dot);
          moving = {
            x: p.x,
            y: p.y,
            dx: 0,
            dy: 0,
            idx: [dot],
            keep: false,
            target: { from: structuredClone(L.items[dot]!) },
          };
          syncMarker();
          cv.setCursor("grabbing");
          cv.requestRenderAll();
          return;
        }
        const hit = L.hitAt(p.x, p.y, 6 / cv.getZoom());
        if (hit < 0) {
          L.selected.clear();
          syncMarker();
          cv.requestRenderAll();
          return;
        }
        if (!L.selected.has(hit)) {
          L.selected.clear();
          L.selected.add(hit);
        }
        const idx = [...L.selected];
        moving = {
          x: p.x,
          y: p.y,
          dx: 0,
          dy: 0,
          idx,
          keep: idx.length === 1 && L.items[idx[0]!]?.type === "marker",
        };
        cv.setCursor("grabbing");
        cv.requestRenderAll();
        return;
      }
      if (t === "select") {
        // A click selects what is under the pointer; a drag always draws the selection box,
        // even when it starts on a line (dense drawings have a line under almost every pixel).
        const p = cv.getScenePoint(ev);
        const v = cv.getViewportPoint(ev);
        const hit = layerRef.current.hitAt(p.x, p.y, 6 / cv.getZoom());
        marquee = { x0: v.x, y0: v.y, x1: v.x, y1: v.y, hit, shift: ev.shiftKey };
        return;
      }
      if (t === "trim") {
        const p = cv.getScenePoint(ev);
        if (layerRef.current.trimAt(p.x, p.y, 6 / cv.getZoom())) {
          syncHist();
          cv.requestRenderAll();
          log("Linea tagliata fino agli incroci");
        } else log("Niente da tagliare: clicca una linea che incrocia un'altra");
        return;
      }
      if (t === "marker") {
        const p = cv.getScenePoint(ev);
        markerDrag = { x0: p.x, y0: p.y, x: p.x, y: p.y };
        return;
      }
      if (t === "line" || t === "rect") {
        start = end = cv.getScenePoint(ev);
        drawColor = colorRef.current;
        drawing =
          t === "line"
            ? new Line([start.x, start.y, start.x, start.y], {
                stroke: drawColor,
                strokeWidth: thickRef.current,
                ...previewProps,
              })
            : new Rect({
                left: start.x,
                top: start.y,
                width: 0,
                height: 0,
                fill: "transparent",
                stroke: drawColor,
                strokeWidth: thickRef.current,
                ...previewProps,
              });
        cv.add(drawing);
      }
    });
    cv.on("mouse:move", (opt) => {
      const ev = opt.e as MouseEvent;
      if (sheetDrag && sheetRef.current) {
        const p = cv.getScenePoint(ev);
        const sh = sheetRef.current;
        if (sheetDrag.mode === "move") {
          sh.x = p.x - sheetDrag.ax;
          sh.y = p.y - sheetDrag.ay;
        } else {
          // corner opposite to the one being dragged stays put; proportions stay A4
          const ratio = sheetRatio(sh.land);
          const w = Math.max(
            Math.abs(p.x - sheetDrag.ax),
            Math.abs(p.y - sheetDrag.ay) * ratio,
            1e-6,
          );
          const h = w / ratio;
          sh.w = w;
          sh.h = h;
          sh.x = p.x < sheetDrag.ax ? sheetDrag.ax - w : sheetDrag.ax;
          sh.y = p.y < sheetDrag.ay ? sheetDrag.ay - h : sheetDrag.ay;
          syncMarkerSize(); // numbers follow the frame's scale while it is resized
        }
        cv.requestRenderAll();
        return;
      }
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
      if (markerDrag) {
        const p = cv.getScenePoint(ev);
        markerDrag.x = p.x;
        markerDrag.y = p.y;
        cv.requestRenderAll();
        return;
      }
      if (moving) {
        const p = cv.getScenePoint(ev);
        const dx = p.x - moving.x,
          dy = p.y - moving.y;
        if (moving.target) layerRef.current.setTarget(moving.idx[0]!, p.x, p.y);
        else layerRef.current.translate(moving.idx, dx, dy, moving.keep);
        moving.x = p.x;
        moving.y = p.y;
        moving.dx += dx;
        moving.dy += dy;
        cv.requestRenderAll();
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
      if (sheetDrag) {
        sheetDrag = null;
        return;
      }
      if (markerDrag) {
        const m = markerDrag;
        markerDrag = null;
        const dragged = Math.hypot(m.x - m.x0, m.y - m.y0) * cv.getZoom() > 6;
        if (dragged) placeMarker(m.x, m.y, m.x0, m.y0);
        else placeMarker(m.x0, m.y0);
        return;
      }
      if (panning) {
        panning = false;
        cv.setCursor(toolRef.current === "pan" ? "grab" : "default");
        return;
      }
      if (moving) {
        const m = moving;
        moving = null;
        cv.setCursor("move");
        if (m.target) layerRef.current.recordEdit(m.idx[0]!, m.target.from);
        else layerRef.current.recordMove(m.idx, m.dx, m.dy, m.keep);
        syncHist();
        syncMarker();
        if (m.dx || m.dy)
          log(
            m.target
              ? "Punto del numero spostato"
              : m.idx.length > 1
                ? `${m.idx.length} elementi spostati`
                : "Elemento spostato",
          );
        else
          log(m.idx.length === 1 ? "Elemento selezionato" : `${m.idx.length} elementi selezionati`);
        return;
      }
      if (erasing) {
        erasing = false;
        lastErase = null;
        const n = erasedIdx.length;
        if (n) {
          layerRef.current.record("remove", erasedIdx); // one undo step per eraser stroke
          syncHist();
          log(n > 1 ? `${n} elementi cancellati` : "Elemento cancellato");
        }
        return;
      }
      if (marquee) {
        const m = marquee;
        marquee = null;
        const L = layerRef.current;
        if (Math.abs(m.x1 - m.x0) > 3 || Math.abs(m.y1 - m.y0) > 3) {
          // drag: selection box (inside or crossing)
          const vpt = cv.viewportTransform!;
          const toScene = (x: number, y: number) => ({
            x: (x - vpt[4]!) / vpt[0]!,
            y: (y - vpt[5]!) / vpt[3]!,
          });
          if (!m.shift) L.selected.clear();
          const a = toScene(m.x0, m.y0),
            b = toScene(m.x1, m.y1);
          const crossing = m.x1 < m.x0;
          for (const i of crossing ? L.touchRect(a, b) : L.insideRect(a, b)) L.selected.add(i);
          const n = L.selected.size;
          if (n)
            log(
              `${n === 1 ? "1 elemento selezionato" : `${n} elementi selezionati`}` +
                ` (${crossing ? "a contatto" : "tutto dentro"}): premi Canc`,
            );
          else log(crossing ? "Nessun elemento toccato" : "Nessun elemento interamente dentro");
        } else if (m.hit >= 0) {
          // click on an element (shift toggles it in the current selection)
          if (m.shift && L.selected.has(m.hit)) L.selected.delete(m.hit);
          else {
            if (!m.shift) L.selected.clear();
            L.selected.add(m.hit);
          }
        } else if (!m.shift) L.selected.clear(); // click on empty space
        syncMarker();
        cv.requestRenderAll();
        return;
      }
      if (drawing && start && end) {
        const isLine = drawing instanceof Line;
        cv.remove(drawing);
        const dx = end.x - start.x,
          dy = end.y - start.y;
        if (isLine && Math.hypot(dx, dy) >= 2) {
          layerRef.current.addUndoable({
            type: "line",
            x1: start.x,
            y1: start.y,
            x2: end.x,
            y2: end.y,
            color: drawColor,
            w: thickRef.current,
          });
          log("Linea creata");
        } else if (!isLine && Math.abs(dx) >= 2 && Math.abs(dy) >= 2) {
          layerRef.current.addUndoable({
            type: "rect",
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            w: Math.abs(dx),
            h: Math.abs(dy),
            color: drawColor,
            sw: thickRef.current,
          });
          log("Rettangolo creato");
        }
        drawing = null;
        start = end = null;
        syncHist();
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
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if (k === "y" || (k === "z" && e.shiftKey)) {
          e.preventDefault();
          redo();
        } else if (k === "c") {
          e.preventDefault();
          copySelected();
        } else if (k === "v") {
          e.preventDefault();
          pasteClipboard();
        }
        return;
      }
      if (e.altKey) return;
      const shortcut: Record<string, Tool> = {
        s: "select",
        l: "line",
        r: "rect",
        e: "erase",
        p: "pan",
        n: "marker",
        t: "trim",
        m: "move",
      };
      if (e.key.toLowerCase() === "x") {
        explodeSelected();
        return;
      }
      const t = shortcut[e.key.toLowerCase()];
      if (t) applyTool(t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, explodeSelected, applyTool, undo, redo, copySelected, pasteClipboard]);

  /** Reopen a saved project: drawing, numbers layer, A4 frame, settings and view. */
  const openProject = async (f: File, handle: FileSystemFileHandle | null) => {
    setLoading("Lettura progetto…");
    try {
      const r = parseProject(await f.text());
      if (!r.ok) {
        log(`Progetto non aperto: ${r.error}`);
        return;
      }
      const p = r.project;
      if (!p.ents.length) {
        log("Il progetto non contiene elementi");
        return;
      }
      const cv = cvRef.current;
      if (!cv) return;
      setFileName(p.name);
      fileHandleRef.current = handle;
      loadDrawing(p.ents);
      thickRef.current = p.settings.thickness;
      setThickness(p.settings.thickness);
      markerSizeRef.current = p.settings.markerSize;
      setMarkerSizeState(p.settings.markerSize);
      setMarkerNext(p.settings.markerNext);
      setColor(p.settings.color);
      layerRef.current.setMarkersVisible(!p.numbersHidden);
      setNumbersHidden(p.numbersHidden);
      if (p.sheet) {
        sheetRef.current = { ...p.sheet };
        setSheetOn(true);
        setSheetLand(p.sheet.land);
        sheetLockedRef.current = p.sheetLocked;
        setSheetLocked(p.sheetLocked);
        onlyRef.current = p.only;
        setOnlyCount(p.only?.length ?? 0);
        setOnlyChecked(p.onlyChecked);
        syncMarkerSize();
      }
      if (p.view) {
        cv.setViewportTransform(p.view as [number, number, number, number, number, number]);
        setZoom(p.view[0]!);
      }
      cv.requestRenderAll();
      log(
        `${f.name}: progetto aperto (${p.ents.length} elementi` +
          (r.dropped ? `, ${r.dropped} non validi saltati)` : ")"),
      );
    } catch (err) {
      log(`Errore lettura progetto: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(null);
    }
  };

  /** Save everything as a .json project that reopens exactly as it is now. */
  const saveProject = async () => {
    const cv = cvRef.current;
    if (!cv) return;
    const L = layerRef.current;
    const ents: Ent[] = [];
    const where = new Map<number, number>(); // layer index -> position in the file
    L.items.forEach((e, i) => {
      if (e) {
        where.set(i, ents.length);
        ents.push(e);
      }
    });
    const sh = sheetRef.current;
    const only = (onlyRef.current ?? [])
      .map((i) => where.get(i))
      .filter((i): i is number => i !== undefined);
    const project = buildProject({
      name: fileName,
      ents,
      numbersHidden: L.hideMarkers,
      sheet: sh ? { ...sh } : null,
      sheetLocked: sheetLockedRef.current,
      only: only.length ? only : null,
      onlyChecked,
      settings: {
        thickness: thickRef.current,
        markerSize: markerSizeRef.current,
        markerNext: markerNextRef.current,
        color: colorRef.current,
      },
      view: [...cv.viewportTransform!],
    });
    await saveOutput(new Blob([JSON.stringify(project)], { type: "application/json" }), {
      name: baseName() + "_progetto.json",
      ext: ".json",
      mime: "application/json",
      label: "Progetto",
    });
  };

  const handleFile = async (f: File, handle: FileSystemFileHandle | null = null) => {
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "json") {
      await openProject(f, handle);
      return;
    }
    if (ext === "dwg") {
      setLoading("Lettura DWG…");
      try {
        const r = await parseDwg(await f.arrayBuffer(), (step) => setLoading(step));
        if (!r.ents.length) {
          log("Nessuna entità supportata nel file DWG");
          return;
        }
        setLoading(`Disegno di ${r.ents.length} entità…`);
        await new Promise((res) => setTimeout(res, 30));
        setFileName(f.name);
        setDwgName(f.name);
        fileHandleRef.current = handle;
        loadDrawing(r.ents);
        const skipped = Object.entries(r.skipped)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ");
        log(
          `${f.name}: ${r.ents.length} entità caricate` +
            (skipped ? ` (non supportate: ${skipped})` : ""),
        );
      } catch (err) {
        log(`Errore lettura DWG: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(null);
      }
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
      fileHandleRef.current = handle;
      loadDrawing(ents);
      log(`${f.name}: ${ents.length} entità caricate`);
    } catch (err) {
      log(`Errore lettura DXF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(null);
    }
  };

  const baseName = () => fileName.replace(/\.(dwg|dxf)$/i, "");

  /** Save a finished file: "Save as" window when the browser has one, otherwise ask, then download. */
  const saveOutput = async (
    blob: Blob,
    o: { name: string; ext: string; mime: string; label: string },
  ) => {
    const result = await saveWithPicker(blob, {
      suggestedName: o.name,
      description: o.label,
      mime: o.mime,
      ext: o.ext,
      startIn: fileHandleRef.current,
    });
    if (result === "saved") log(`${o.label} salvato`);
    else if (result === "cancelled") log("Salvataggio annullato");
    else setSaveNotice({ blob, name: o.name, ext: o.ext, label: o.label });
  };

  const confirmDownload = () => {
    if (!saveNotice) return;
    const name = cleanFileName(saveNotice.name, saveNotice.ext);
    downloadBlob(saveNotice.blob, name);
    log(`${saveNotice.label} scaricato: ${name}`);
    setSaveNotice(null);
  };

  const exportDxf = async () => {
    if (!cvRef.current) return;
    setLoading("Generazione DXF sul server…");
    await new Promise((r) => setTimeout(r, 400)); // simulated server step; lets the loader paint
    const blob = new Blob(
      [toDxf(layerRef.current.toEnts(), { numbersOff: layerRef.current.hideMarkers })],
      { type: "application/dxf" },
    );
    setLoading(null);
    await saveOutput(blob, {
      name: baseName() + "_modificato.dxf",
      ext: ".dxf",
      mime: "application/dxf",
      label: "DXF",
    });
  };

  /** DXF a parte (R2000 con BLOCKS e handle) per il DWG aperto; "Esporta DXF" non cambia. */
  const exportDxfBlocks = async () => {
    if (!cvRef.current) return;
    const dxf = drawingToDxf(layerRef.current.toEnts(), {
      numbersOff: layerRef.current.hideMarkers,
    });
    await saveOutput(new Blob([dxf], { type: "application/dxf" }), {
      name: baseName() + "_convertito.dxf",
      ext: ".dxf",
      mime: "application/dxf",
      label: "DXF (con BLOCKS)",
    });
  };

  const exportPng = async () => {
    if (!cvRef.current) return;
    setLoading("Creazione immagine…");
    await new Promise((r) => setTimeout(r, 30));
    const blob = await layerRef.current.toPngBlob();
    setLoading(null);
    if (!blob) {
      log("Niente da esportare: il disegno è vuoto");
      return;
    }
    await saveOutput(blob, {
      name: baseName() + ".png",
      ext: ".png",
      mime: "image/png",
      label: "Immagine PNG (sfondo trasparente)",
    });
  };

  const exportSheet = async () => {
    const sh = sheetRef.current;
    if (!sh) return;
    setLoading("Creazione immagine A4…");
    await new Promise((r) => setTimeout(r, 30));
    syncMarkerSize();
    const only = onlyChecked && onlyRef.current ? onlyRef.current : undefined;
    const blob = await layerRef.current.toSheetPngBlob(sh, only);
    setLoading(null);
    if (!blob) {
      log("Impossibile creare l'immagine");
      return;
    }
    await saveOutput(blob, {
      name: baseName() + "_A4.png",
      ext: ".png",
      mime: "image/png",
      label: "Immagine PNG A4 (sfondo trasparente, solo il contenuto del foglio)",
    });
  };

  /** "Carica DXF": system picker when available (keeps the folder), plain input otherwise. */
  const openFile = async () => {
    const r = await pickFileToOpen();
    if (r === "unsupported") inputRef.current?.click();
    else if (r) handleFile(r.file, r.handle);
  };

  const runCommand = (raw: string) => {
    const c = raw.trim().toLowerCase();
    if (!c) return;
    const col = PALETTE.find((p) => p.label.toLowerCase() === c);
    if (col) {
      setColor(col.value);
      log(`Colore: ${col.label}`);
    } else if (["canc", "cancella", "del", "delete", "elimina"].includes(c)) deleteSelected();
    else if (["copia", "copy", "co"].includes(c)) copySelected();
    else if (["incolla", "paste", "in"].includes(c)) pasteClipboard();
    else if (["a4", "foglio"].includes(c)) toggleSheet();
    else if (["sposta", "move", "m"].includes(c)) {
      applyTool("move");
      log("SPOSTA attivo: trascina un elemento (o la selezione) dove vuoi");
    } else if (["x", "esplodi", "espl", "explode"].includes(c)) {
      explodeSelected();
    } else if (["trim", "taglia", "tr"].includes(c)) {
      applyTool("trim");
      log("TRIM attivo: clicca la parte di linea da tagliare fino agli incroci");
    } else if (["annulla", "undo", "u"].includes(c)) undo();
    else if (["ripeti", "redo"].includes(c)) redo();
    else if (["linea", "line", "l"].includes(c)) {
      applyTool("line");
      log("Comando LINEA attivo");
    } else if (["rettangolo", "rett", "rect", "r"].includes(c)) {
      applyTool("rect");
      log("Comando RETTANGOLO attivo");
    } else if (["gomma", "erase", "e"].includes(c)) {
      applyTool("erase");
      log("GOMMA attiva: clicca o trascina sugli elementi");
    } else if (["numero", "num", "n"].includes(c)) {
      applyTool("marker");
      log("NUMERO attivo: clicca per inserire un numero cerchiato");
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
    else if (["png", "immagine", "img"].includes(c)) exportPng();
    else log(`Comando sconosciuto: "${raw}"`);
    setCmd("");
  };

  const tools: { id: Tool; icon: ComponentType<{ className?: string }>; label: string }[] = [
    { id: "select", icon: MousePointer2, label: "Seleziona / riquadro (S)" },
    { id: "erase", icon: Eraser, label: "Gomma: clicca o trascina per cancellare (E)" },
    { id: "line", icon: Minus, label: "Linea (L)" },
    { id: "rect", icon: Square, label: "Rettangolo (R)" },
    { id: "move", icon: Move, label: "Sposta: trascina un elemento o la selezione (M)" },
    {
      id: "trim",
      icon: Scissors,
      label: "Taglia (Trim): clicca la parte di linea da togliere (T)",
    },
    {
      id: "marker",
      icon: MarkerIcon,
      label: "Numero cerchiato: clicca per inserire 00, 01, 02… (N)",
    },
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
              placeholder="linea, rett, numero, sposta, trim, copia, incolla, canc, annulla…"
              className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
              aria-label="Linea di comando"
            />
          </form>
        </div>
        <div className="flex items-center gap-2 border-l border-border px-4">
          <button
            onClick={openFile}
            title="Apri un disegno DXF o un progetto salvato (.json)"
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
          >
            <Upload className="h-4 w-4" /> Apri file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".dxf,.dwg,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          {sheetOn && (
            <button
              onClick={exportSheet}
              title="Salva come PNG solo quello che sta dentro il foglio A4 (300 dpi, sfondo trasparente)"
              className="inline-flex items-center gap-2 rounded-md border border-amber-500 px-3 py-2 text-sm hover:bg-accent"
            >
              <Frame className="h-4 w-4" /> Esporta A4
            </button>
          )}
          <button
            onClick={saveProject}
            title="Salva tutto in un file .json: disegno, numeri, foglio A4, impostazioni e vista"
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
          >
            <Save className="h-4 w-4" /> Salva progetto
          </button>
          <button
            onClick={exportPng}
            title="Salva come immagine PNG con sfondo trasparente"
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
          >
            <ImageDown className="h-4 w-4" /> Esporta PNG
          </button>
          {dwgName !== null && dwgName === fileName && (
            <button
              onClick={exportDxfBlocks}
              title="Scarica il DWG aperto come DXF (R2000 con sezione BLOCKS)"
              className="inline-flex items-center gap-2 rounded-md border border-primary px-3 py-2 text-sm hover:bg-accent"
            >
              <FileDown className="h-4 w-4" /> Scarica come DXF
            </button>
          )}
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
        <aside className="z-10 flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-card py-3">
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
            title="Esplodi: trasforma la polilinea selezionata in linee singole (X)"
            aria-label="Esplodi"
            onClick={explodeSelected}
            className="grid h-11 w-11 place-items-center rounded-md text-foreground transition-colors hover:bg-accent"
          >
            <Split className="h-5 w-5" />
          </button>
          <button
            title="Elimina (Canc)"
            aria-label="Elimina"
            onClick={deleteSelected}
            className="grid h-11 w-11 place-items-center rounded-md text-destructive hover:bg-destructive/15"
          >
            <Trash2 className="h-5 w-5" />
          </button>
          <button
            title="Copia (Ctrl+C)"
            aria-label="Copia"
            onClick={copySelected}
            className="grid h-11 w-11 place-items-center rounded-md text-foreground transition-colors hover:bg-accent"
          >
            <Copy className="h-5 w-5" />
          </button>
          <button
            title="Incolla (Ctrl+V)"
            aria-label="Incolla"
            onClick={pasteClipboard}
            className="grid h-11 w-11 place-items-center rounded-md text-foreground transition-colors hover:bg-accent"
          >
            <ClipboardPaste className="h-5 w-5" />
          </button>
          <button
            title="Annulla (Ctrl+Z)"
            aria-label="Annulla"
            onClick={undo}
            disabled={!hist.undo}
            className="grid h-11 w-11 place-items-center rounded-md text-foreground transition-colors hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Undo2 className="h-5 w-5" />
          </button>
          <button
            title="Ripeti (Ctrl+Y)"
            aria-label="Ripeti"
            onClick={redo}
            disabled={!hist.redo}
            className="grid h-11 w-11 place-items-center rounded-md text-foreground transition-colors hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Redo2 className="h-5 w-5" />
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
            // the handle must be requested synchronously, before the event ends
            const item = e.dataTransfer.items[0] as
              | (DataTransferItem & {
                  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
                })
              | undefined;
            const pending = item?.getAsFileSystemHandle?.();
            if (f)
              (pending ?? Promise.resolve(null)).then(
                (h) => handleFile(f, h?.kind === "file" ? (h as FileSystemFileHandle) : null),
                () => handleFile(f),
              );
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

          {/* THICKNESS (and number options) */}
          <div className="absolute left-1/2 top-3 z-10 flex w-max max-w-[calc(100%-6rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card/95 px-3 py-1.5 text-xs shadow-lg">
            <div className="flex items-center gap-1" role="group" aria-label="Spessore linea">
              <span className="mr-1 text-muted-foreground">Spessore</span>
              {THICKNESS.map((px) => (
                <button
                  key={px}
                  title={`Spessore ${px} px: vale per ciò che disegni e per gli elementi selezionati`}
                  aria-label={`Spessore ${px}`}
                  aria-pressed={thickness === px}
                  onClick={() => chooseThickness(px)}
                  className={`grid h-8 w-9 place-items-center rounded-md ${thickness === px ? "bg-primary/20 ring-1 ring-primary" : "hover:bg-accent"}`}
                >
                  <span
                    className="block w-6 rounded-full bg-current"
                    style={{ height: px }}
                    aria-hidden
                  />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-l border-border pl-3">
              <button
                aria-label="Foglio A4"
                aria-pressed={sheetOn}
                onClick={toggleSheet}
                title="Mostra il foglio A4 per sistemare il disegno ed esportare solo quello che c'è dentro"
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${sheetOn ? "border-amber-500 bg-amber-500/20" : "border-border hover:bg-accent"}`}
              >
                <Frame className="h-4 w-4" /> Foglio A4
              </button>
              <button
                aria-label="Foglio sulla selezione"
                disabled={sheetLocked}
                onClick={sheetOnSelection}
                title="Seleziona una parte del disegno, poi premi qui: il foglio A4 si mette intorno, al centro"
                className="rounded-md border border-border px-2 py-1 hover:bg-accent disabled:opacity-40"
              >
                Foglio sulla selezione
              </button>
              {sheetOn && onlyCount > 0 && (
                <label className="flex items-center gap-1.5 text-muted-foreground">
                  <input
                    type="checkbox"
                    aria-label="Solo gli elementi scelti"
                    checked={onlyChecked}
                    onChange={(e) => setOnlyChecked(e.target.checked)}
                  />
                  Solo i {onlyCount} scelti (più i numeri)
                </label>
              )}
              {sheetOn && (
                <>
                  <div
                    className="flex items-center gap-1"
                    role="group"
                    aria-label="Orientamento foglio"
                  >
                    {[
                      { land: false, label: "Verticale" },
                      { land: true, label: "Orizzontale" },
                    ].map((o) => (
                      <button
                        key={o.label}
                        aria-label={o.label}
                        aria-pressed={sheetLand === o.land}
                        disabled={sheetLocked}
                        onClick={() => chooseOrientation(o.land)}
                        className={`rounded-md px-2 py-1 ${sheetLand === o.land ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <button
                    aria-label="Adatta al disegno"
                    disabled={sheetLocked}
                    onClick={() => {
                      placeSheet(sheetLand);
                    }}
                    title="Rimette il foglio intorno a tutto il disegno"
                    className="rounded-md border border-border px-2 py-1 hover:bg-accent"
                  >
                    Adatta
                  </button>
                  <button
                    aria-label={sheetLocked ? "Sblocca foglio" : "Fissa foglio"}
                    aria-pressed={sheetLocked}
                    onClick={toggleLock}
                    title={
                      sheetLocked
                        ? "Foglio fissato: clicca per sbloccarlo e spostarlo"
                        : "Fissa il foglio: ingrandisci e inserisci i numeri senza muoverlo"
                    }
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${sheetLocked ? "border-amber-500 bg-amber-500/20" : "border-border hover:bg-accent"}`}
                  >
                    {sheetLocked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
                    {sheetLocked ? "Fissato" : "Fissa"}
                  </button>
                  <div
                    className="flex items-center gap-1"
                    role="group"
                    aria-label="Misura numeri sul foglio"
                  >
                    {(Object.keys(MARKER_MM) as MarkerSize[]).map((sz) => (
                      <button
                        key={sz}
                        aria-label={`Numeri ${sz}`}
                        aria-pressed={markerSize === sz}
                        title={`Cerchio di ${MARKER_MM[sz] * 2} mm sul foglio`}
                        onClick={() => {
                          markerSizeRef.current = sz;
                          setMarkerSizeState(sz);
                          syncMarkerSize();
                        }}
                        className={`rounded-md px-2 py-1 ${markerSize === sz ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                      >
                        {sz} {MARKER_MM[sz] * 2}mm
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div
              className="flex items-center gap-1 border-l border-border pl-3"
              role="group"
              aria-label="Livelli"
            >
              <span className="mr-1 text-muted-foreground">Livelli</span>
              <button
                aria-label="Livello Numeri"
                aria-pressed={!numbersHidden}
                onClick={() => setNumbersVisible(numbersHidden)}
                title={
                  numbersHidden
                    ? "Numeri spenti: clicca per accenderli"
                    : "Numeri accesi: clicca per spegnerli (non si vedono e non si esportano)"
                }
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${numbersHidden ? "border-border text-muted-foreground line-through hover:bg-accent" : "border-primary bg-primary/15"}`}
              >
                {numbersHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}{" "}
                Numeri
              </button>
            </div>
            {editMarker && (tool === "select" || tool === "move") && (
              <label className="flex items-center gap-1.5 border-l border-border pl-3 text-muted-foreground">
                Numero
                <input
                  key={editMarker.i + ":" + editMarker.n}
                  defaultValue={editMarker.n}
                  aria-label="Cambia numero"
                  title="Scrivi il nuovo numero e premi Invio (o clicca fuori)"
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      applyMarkerNumber(editMarker.i, e.currentTarget.value, true);
                    else if (e.key === "Escape") {
                      e.currentTarget.value = editMarker.n; // cancel: keep the old number
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => applyMarkerNumber(editMarker.i, e.currentTarget.value, false)}
                  className="w-14 rounded border border-border bg-background px-2 py-1 text-center font-mono text-foreground outline-none focus:border-primary"
                />
                <span className="text-[10px] opacity-70">Invio per applicare</span>
              </label>
            )}
            {tool === "marker" && (
              <div className="flex items-center gap-2 border-l border-border pl-3">
                <label className="flex items-center gap-1.5 text-muted-foreground">
                  Prossimo n°
                  <input
                    value={String(markerNext).padStart(2, "0")}
                    onChange={(e) => setMarkerNext(parseInt(e.target.value.replace(/\D/g, ""), 10))}
                    inputMode="numeric"
                    aria-label="Prossimo numero"
                    className="w-12 rounded-md border border-border bg-background px-1.5 py-1 text-center font-mono text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <button
                  onClick={() => setMarkerNext(0)}
                  title="Ricomincia da 00"
                  className="rounded-md border border-border px-2 py-1 hover:bg-accent"
                >
                  Azzera
                </button>
                <div className="flex items-center gap-1" role="group" aria-label="Dimensione">
                  {(Object.keys(MARKER_RADIUS_PX) as MarkerSize[]).map((sz) => (
                    <button
                      key={sz}
                      title={`Dimensione ${sz}`}
                      aria-label={`Dimensione ${sz}`}
                      aria-pressed={markerSize === sz}
                      onClick={() => {
                        markerSizeRef.current = sz;
                        setMarkerSizeState(sz);
                        syncMarkerSize();
                      }}
                      className={`h-8 w-8 rounded-md font-semibold ${markerSize === sz ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

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

      <Dialog open={!!saveNotice} onOpenChange={(o) => !o && setSaveNotice(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scegliere la cartella non è possibile</DialogTitle>
            <DialogDescription>
              Questo browser non permette di scegliere dove salvare. Il file verrà scaricato nella
              cartella dei download (o in quella che hai impostato nel browser). Puoi cambiare il
              nome qui sotto.
            </DialogDescription>
          </DialogHeader>
          <input
            value={saveNotice ? saveNotice.name.replace(/\.(dxf|png)$/i, "") : ""}
            onChange={(e) => setSaveNotice((n) => (n ? { ...n, name: e.target.value + n.ext } : n))}
            onKeyDown={(e) => e.key === "Enter" && confirmDownload()}
            aria-label="Nome del file"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          <DialogFooter>
            <button
              onClick={() => setSaveNotice(null)}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
            >
              Annulla
            </button>
            <button
              onClick={confirmDownload}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              OK, scarica
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
