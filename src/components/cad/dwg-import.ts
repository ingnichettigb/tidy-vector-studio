/**
 * =======================================================================
 * File:        dwg-import.ts
 * Percorso:    (src/components/cad/dwg-import.ts)
 * Revisione:   Rev. 1.1
 * Data:        05/11/2026
 * -----------------------------------------------------------------------
 * Storico Revisioni (max 10 voci, oltre la decima si sostituisce la più vecchia):
 * [05/11/2026] Rev. 1.0 - Lettura DWG binario nel browser con @mlightcad/libredwg-web
 *                         (WebAssembly, 100% client): LINE, LWPOLYLINE, CIRCLE, ARC,
 *                         TEXT, MTEXT del solo Spazio Modello.
 * [05/11/2026] Rev. 1.1 - Il disegno perdeva molte linee. Ora anche: INSERT (blocchi,
 *                         annidati, con scala, rotazione, matrici e attributi), DIMENSION
 *                         (quote, dal loro blocco), POLYLINE2D/3D (prima scartate per un
 *                         nome di tipo sbagliato), SPLINE, ELLIPSE, SOLID, 3DFACE, LEADER.
 *                         Geometria spostata in dwg-geometry.ts.
 * =======================================================================
 */

import type { DwgDatabase, DwgEntity } from "@mlightcad/libredwg-web";
import type { Ent } from "./cad-data";
import {
  arcPoints,
  ellipsePoints,
  plainText,
  polylinePoints,
  splinePoints,
  type P,
  type SplineData,
  type V,
} from "./dwg-geometry";

export { plainText };

/**
 * Il file wasm (>10 MB) non può stare in public/: viene caricato con il gestore asset di
 * Lovable, che crea il puntatore src/assets/libredwg-web.wasm.asset.json ({ url }).
 * `import.meta.glob` lascia compilare l'app anche prima che il puntatore esista: in quel
 * caso l'apertura di un DWG mostra un errore chiaro invece di rompere il build.
 */
const wasmAssets = import.meta.glob<{ url: string }>("../../assets/libredwg-web.wasm.asset.json", {
  eager: true,
  import: "default",
});

export type DwgImport = {
  ents: Ent[];
  /** entità scartate perché di un tipo non supportato, per nome (es. HATCH: 4) */
  skipped: Record<string, number>;
  /** entità dello Spazio Carta, nascoste o su layer spento/congelato */
  ignored: number;
};

/** Oltre questo numero di entità si smette di espandere i blocchi (protegge la memoria). */
const MAX_ENTS = 1_500_000;
const MAX_DEPTH = 8; // blocchi dentro blocchi
const MAX_ARRAY = 10_000; // copie di un INSERT a matrice

/* ---------- colori: stessa tabella di dxf-import.ts, così DXF e DWG coincidono ---------- */
const ACI: Record<number, string> = {
  1: "#ff4d4d",
  2: "#b8860b",
  3: "#3ddc84",
  4: "#3dd6dc",
  5: "#4da3ff",
  6: "#e05cff",
  7: "#111111",
  8: "#8a8a8a",
  9: "#777777",
};
const DEFAULT_COLOR = "#111111";

type LayerInfo = { colorIndex: number; hidden: boolean };
type Block = { basePoint?: P; entities: DwgEntity[] };

/** Dove siamo: come si trasformano i punti, e cosa un blocco passa alle entità che contiene. */
type Ctx = {
  tf: (p: P) => P;
  scale: number; // per la dimensione dei testi
  rot: number; // rotazione accumulata (radianti), per i testi
  color: string | null; // colore dell'INSERT, per le entità DA BLOCCO
  layer: string | null; // layer dell'INSERT, per le entità sul layer "0"
  depth: number;
};

type E<T> = DwgEntity & T;

/**
 * Database LibreDWG -> entità dell'editor (asse Y capovolto per lo schermo).
 * Funzione pura: separata dal WebAssembly così si può provare senza un file DWG.
 */
export function convertDatabase(db: DwgDatabase): DwgImport {
  const layers = new Map<string, LayerInfo>();
  for (const l of db.tables?.LAYER?.entries ?? [])
    layers.set(l.name, { colorIndex: l.colorIndex, hidden: !!(l.off || l.frozen) });

  // i blocchi per nome (i due spazi di sistema non sono blocchi da inserire)
  const blocks = new Map<string, Block>();
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? [])
    if (!/^\*(model|paper)_space/i.test(b.name)) blocks.set(b.name, b);

  const ents: Ent[] = [];
  const skipped: Record<string, number> = {};
  let ignored = 0;
  const skip = (name: string) => (skipped[name] = (skipped[name] ?? 0) + 1);

  const colorOf = (e: DwgEntity, layer: string, ctx: Ctx): string => {
    let idx = e.colorIndex;
    if (idx === 0 && ctx.color) return ctx.color; // DA BLOCCO: prende il colore dell'INSERT
    if (idx === undefined || idx === 256 || idx === 0) idx = layers.get(layer)?.colorIndex;
    if (idx !== undefined && ACI[Math.abs(idx)]) return ACI[Math.abs(idx)]!;
    const c = e.color;
    if (typeof c === "number" && c !== 0 && c !== 0xffffff && c < 0xe0e0e0)
      return "#" + c.toString(16).padStart(6, "0");
    return DEFAULT_COLOR;
  };

  const walk = (list: DwgEntity[], ctx: Ctx) => {
    const poly = (pts: P[], color: string) => {
      const f = pts.map((p) => {
        const q = ctx.tf(p);
        return { x: q.x, y: -q.y };
      });
      if (f.length === 2)
        ents.push({ type: "line", x1: f[0]!.x, y1: f[0]!.y, x2: f[1]!.x, y2: f[1]!.y, color });
      else if (f.length > 2) ents.push({ type: "poly", pts: f, color });
    };
    const text = (raw: string, at: P, height: number, rot: number, color: string) => {
      const t = plainText(raw);
      if (!t) return;
      const h = (height || 2.5) * ctx.scale;
      const q = ctx.tf(at);
      const deg = -((rot + ctx.rot) * 180) / Math.PI; // in DWG le rotazioni sono in radianti
      ents.push({
        type: "text",
        x: q.x,
        y: -q.y - h,
        text: t,
        size: h,
        color,
        ...(deg ? { angle: deg } : {}),
      });
    };

    for (const e of list) {
      if (ents.length >= MAX_ENTS) {
        skipped["entità oltre il limite"] = 1;
        return;
      }
      // sul layer "0" dentro un blocco valgono layer e colore dell'INSERT
      const layer = e.layer === "0" && ctx.layer ? ctx.layer : e.layer;
      // solo Spazio Modello; invisibili e layer spenti non si vedono in AutoCAD, quindi non qui
      if (
        (ctx.depth === 0 && e.isInPaperSpace) ||
        e.isVisible === false ||
        layers.get(layer)?.hidden
      ) {
        ignored++;
        continue;
      }
      const color = colorOf(e, layer, ctx);
      switch (e.type) {
        case "LINE": {
          const l = e as E<{ startPoint: P; endPoint: P }>;
          poly([l.startPoint, l.endPoint], color);
          break;
        }
        case "LWPOLYLINE": {
          const l = e as E<{ flag: number; vertices: V[] }>;
          if ((l.vertices?.length ?? 0) > 1)
            poly(polylinePoints(l.vertices, (l.flag & 1) === 1 && l.vertices.length > 2), color);
          break;
        }
        case "POLYLINE2D":
        case "POLYLINE3D": {
          const l = e as E<{ flag: number; vertices: (V & { flag?: number })[] }>;
          if (l.flag & 64) {
            skip("POLYFACE"); // maglia di facce: non è un disegno di linee
            break;
          }
          // i vertici "punto di controllo" (16) non fanno parte della curva visibile
          const v = (l.vertices ?? []).filter((q) => !((q.flag ?? 0) & 16));
          if (v.length > 1) poly(polylinePoints(v, (l.flag & 1) === 1 && v.length > 2), color);
          break;
        }
        case "CIRCLE": {
          const c = e as E<{ center: P; radius: number }>;
          if (c.radius > 0)
            poly(arcPoints(c.center.x, c.center.y, c.radius, 0, Math.PI * 2), color);
          break;
        }
        case "ARC": {
          const a = e as E<{ center: P; radius: number; startAngle: number; endAngle: number }>;
          if (a.radius > 0)
            poly(arcPoints(a.center.x, a.center.y, a.radius, a.startAngle, a.endAngle), color);
          break;
        }
        case "ELLIPSE": {
          const l = e as E<{
            center: P;
            majorAxisEndPoint: P;
            axisRatio: number;
            startAngle: number;
            endAngle: number;
          }>;
          poly(
            ellipsePoints(l.center, l.majorAxisEndPoint, l.axisRatio, l.startAngle, l.endAngle),
            color,
          );
          break;
        }
        case "SPLINE":
          poly(splinePoints(e as E<SplineData>), color);
          break;
        case "SOLID":
        case "3DFACE": {
          // il contorno (il riempimento non c'è): i vertici 3 e 4 di un SOLID sono scambiati
          const s = e as E<{ corner1: P; corner2: P; corner3: P; corner4?: P }>;
          const c4 = s.corner4 ?? s.corner3;
          const order =
            e.type === "SOLID"
              ? [s.corner1, s.corner2, c4, s.corner3]
              : [s.corner1, s.corner2, s.corner3, c4];
          poly([...order, order[0]!], color);
          break;
        }
        case "LEADER": {
          const l = e as E<{ vertices: P[] }>;
          if ((l.vertices?.length ?? 0) > 1) poly(l.vertices, color);
          break;
        }
        case "TEXT":
        case "MTEXT": {
          const t = e as E<{
            text: string;
            textHeight: number;
            rotation?: number;
            startPoint?: P;
            insertionPoint?: P;
          }>;
          const at = t.startPoint ?? t.insertionPoint;
          if (at) text(t.text, at, t.textHeight, t.rotation ?? 0, color);
          break;
        }
        case "DIMENSION": {
          // la quota è già disegnata in un blocco anonimo (*D1...): si espande senza trasformarla
          const b = blocks.get((e as E<{ name: string }>).name);
          if (b && ctx.depth < MAX_DEPTH) walk(b.entities, { ...ctx, depth: ctx.depth + 1 });
          else skip("DIMENSION");
          break;
        }
        case "INSERT": {
          const ins = e as E<{
            name: string;
            insertionPoint: P;
            xScale: number;
            yScale: number;
            rotation: number;
            columnCount: number;
            rowCount: number;
            columnSpacing: number;
            rowSpacing: number;
            attribs?: E<{
              text?: { text: string; startPoint: P; textHeight: number; rotation: number };
              flags?: number;
            }>[];
          }>;
          const b = blocks.get(ins.name);
          if (!b || ctx.depth >= MAX_DEPTH) {
            skip("INSERT");
            break;
          }
          const sx = ins.xScale || 1,
            sy = ins.yScale || 1,
            rot = ins.rotation || 0;
          const cos = Math.cos(rot),
            sin = Math.sin(rot);
          const bp = b.basePoint ?? { x: 0, y: 0 };
          const cols = Math.min(MAX_ARRAY, Math.max(1, ins.columnCount || 1));
          const rows = Math.min(MAX_ARRAY / cols, Math.max(1, ins.rowCount || 1));
          for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
              // le copie di una matrice distano lungo gli assi dell'INSERT, già ruotati
              const dx = c * (ins.columnSpacing || 0),
                dy = r * (ins.rowSpacing || 0);
              const ox = ins.insertionPoint.x + dx * cos - dy * sin,
                oy = ins.insertionPoint.y + dx * sin + dy * cos;
              walk(b.entities, {
                tf: (q) => {
                  const x = (q.x - bp.x) * sx,
                    y = (q.y - bp.y) * sy;
                  return ctx.tf({ x: ox + x * cos - y * sin, y: oy + x * sin + y * cos });
                },
                scale: ctx.scale * Math.abs(sx),
                rot: ctx.rot + rot,
                color,
                layer,
                depth: ctx.depth + 1,
              });
            }
          // gli attributi (es. i dati del cartiglio) hanno già coordinate nel disegno
          for (const a of ins.attribs ?? [])
            if (a.text && !((a.flags ?? 0) & 1))
              text(
                a.text.text,
                a.text.startPoint,
                a.text.textHeight,
                a.text.rotation ?? 0,
                colorOf(a, a.layer === "0" ? layer : a.layer, ctx),
              );
          break;
        }
        default:
          skip(e.type);
      }
    }
  };

  walk(db.entities ?? [], { tf: (p) => p, scale: 1, rot: 0, color: null, layer: null, depth: 0 });
  return { ents, skipped, ignored };
}

/* ---------- motore WebAssembly ---------- */
type Lib = import("@mlightcad/libredwg-web").LibreDwgEx;
let libPromise: Promise<Lib> | null = null;

async function getLib(): Promise<Lib> {
  if (!libPromise) {
    libPromise = (async () => {
      const wasmUrl = Object.values(wasmAssets)[0]?.url;
      if (!wasmUrl)
        throw new Error(
          "motore DWG non installato: carica libredwg-web.wasm con il gestore asset di Lovable " +
            "(crea src/assets/libredwg-web.wasm.asset.json)",
        );
      const m = await import("@mlightcad/libredwg-web"); // solo quando serve un DWG
      const mod = await m.createModule({ locateFile: () => wasmUrl });
      return m.LibreDwg.createByWasmInstance(mod);
    })();
    libPromise.catch(() => (libPromise = null)); // al prossimo tentativo riprova
  }
  return libPromise;
}

/** Un DWG comincia con la versione in chiaro: "AC1015", "AC1032"... */
export function looksLikeDwg(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength));
  return /^AC10\d\d$/.test(String.fromCharCode(...head));
}

/** Legge un file DWG e ne estrae le entità dello Spazio Modello. */
export async function parseDwg(
  buffer: ArrayBuffer,
  onProgress?: (step: string) => void,
): Promise<DwgImport> {
  // senza questo controllo un file qualsiasi darebbe comunque un puntatore valido
  if (!looksLikeDwg(buffer)) throw new Error("il file non è un DWG valido");
  onProgress?.("Avvio motore DWG…");
  const lib = await getLib();
  const { Dwg_File_Type } = await import("@mlightcad/libredwg-web");
  onProgress?.("Decodifica del DWG…");
  const dwg = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
  if (!dwg) throw new Error("impossibile leggere il DWG (file danneggiato o protetto)");
  let db: DwgDatabase;
  try {
    db = lib.convert(dwg);
  } finally {
    lib.dwg_free(dwg); // libera la memoria del WebAssembly anche se la conversione fallisce
  }
  onProgress?.("Conversione delle geometrie…");
  return convertDatabase(db);
}
