/**
 * =======================================================================
 * File:        dwg-import.ts
 * Percorso:    (src/components/cad/dwg-import.ts)
 * Revisione:   Rev. 1.0
 * Data:        05/11/2026
 * -----------------------------------------------------------------------
 * Storico Revisioni (max 10 voci, oltre la decima si sostituisce la più vecchia):
 * [05/11/2026] Rev. 1.0 - Lettura DWG binario nel browser con @mlightcad/libredwg-web
 *                         (WebAssembly, 100% client): LINE, LWPOLYLINE, CIRCLE, ARC,
 *                         TEXT, MTEXT del solo Spazio Modello. File nuovo: non modifica
 *                         nessun modulo esistente.
 * =======================================================================
 */

import type { DwgDatabase, DwgEntity } from "@mlightcad/libredwg-web";
import type { Ent } from "./cad-data";

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
  /** entità scartate perché di un tipo non supportato, per nome (es. INSERT: 4) */
  skipped: Record<string, number>;
  /** entità dello Spazio Carta, nascoste o su layer spento/congelato */
  ignored: number;
};

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

function colorOf(e: DwgEntity, layers: Map<string, LayerInfo>): string {
  let idx = e.colorIndex;
  if (idx === undefined || idx === 256 || idx === 0) idx = layers.get(e.layer)?.colorIndex;
  if (idx !== undefined && ACI[Math.abs(idx)]) return ACI[Math.abs(idx)]!;
  const c = e.color;
  if (typeof c === "number" && c !== 0 && c !== 0xffffff && c < 0xe0e0e0)
    return "#" + c.toString(16).padStart(6, "0");
  return DEFAULT_COLOR;
}

/** Testo di AutoCAD -> testo semplice (codici MTEXT e simboli %%c %%d %%p). */
export function plainText(raw: string): string {
  return String(raw ?? "")
    .replace(/\\P/g, " ")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/%%[cC]/g, "Ø")
    .replace(/%%[dD]/g, "°")
    .replace(/%%[pP]/g, "±")
    .replace(/[{}]/g, "")
    .trim();
}

type P = { x: number; y: number };

/** Punti di un arco in senso antiorario da a0 ad a1 (radianti), come in dxf-import.ts. */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): P[] {
  if (a1 < a0) a1 += Math.PI * 2;
  const n = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 48));
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Punti intermedi (estremi esclusi) di un lato di polilinea con "bulge" (arco). */
function bulgePoints(p1: P, p2: P, bulge: number): P[] {
  const dx = p2.x - p1.x,
    dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  if (!bulge || d < 1e-9) return [];
  const theta = 4 * Math.atan(bulge); // angolo al centro, con segno (+ antiorario)
  const h = d / 2 / Math.tan(theta / 2); // distanza del centro dalla corda, a sinistra se > 0
  const cx = (p1.x + p2.x) / 2 - (dy / d) * h,
    cy = (p1.y + p2.y) / 2 + (dx / d) * h;
  const r = Math.hypot(p1.x - cx, p1.y - cy);
  const a0 = Math.atan2(p1.y - cy, p1.x - cx);
  const n = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * 48));
  const out: P[] = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/**
 * Database LibreDWG -> entità dell'editor (asse Y capovolto per lo schermo).
 * Funzione pura: separata dal WebAssembly così si può provare senza un file DWG.
 */
export function convertDatabase(db: DwgDatabase): DwgImport {
  const layers = new Map<string, LayerInfo>();
  for (const l of db.tables?.LAYER?.entries ?? [])
    layers.set(l.name, { colorIndex: l.colorIndex, hidden: !!(l.off || l.frozen) });

  const ents: Ent[] = [];
  const skipped: Record<string, number> = {};
  let ignored = 0;

  const poly = (pts: P[], color: string) => {
    const flipped = pts.map((p) => ({ x: p.x, y: -p.y }));
    if (flipped.length === 2)
      ents.push({
        type: "line",
        x1: flipped[0]!.x,
        y1: flipped[0]!.y,
        x2: flipped[1]!.x,
        y2: flipped[1]!.y,
        color,
      });
    else if (flipped.length > 2) ents.push({ type: "poly", pts: flipped, color });
  };

  for (const e of db.entities ?? []) {
    // solo Spazio Modello; invisibili e layer spenti non si vedono in AutoCAD, quindi non qui
    if (e.isInPaperSpace || e.isVisible === false || layers.get(e.layer)?.hidden) {
      ignored++;
      continue;
    }
    const color = colorOf(e, layers);
    switch (e.type) {
      case "LINE": {
        const l = e as DwgEntity & { startPoint: P; endPoint: P };
        poly([l.startPoint, l.endPoint], color);
        break;
      }
      case "LWPOLYLINE": {
        const l = e as DwgEntity & {
          flag: number;
          vertices: (P & { bulge?: number })[];
        };
        const v = l.vertices ?? [];
        if (v.length < 2) break;
        const closed = (l.flag & 1) === 1 && v.length > 2;
        const pts: P[] = [];
        const last = closed ? v.length : v.length - 1;
        for (let i = 0; i < last; i++) {
          const a = v[i]!,
            b = v[(i + 1) % v.length]!;
          pts.push({ x: a.x, y: a.y }, ...bulgePoints(a, b, a.bulge ?? 0));
        }
        pts.push(
          closed ? { x: v[0]!.x, y: v[0]!.y } : { x: v[v.length - 1]!.x, y: v[v.length - 1]!.y },
        );
        poly(pts, color);
        break;
      }
      case "CIRCLE": {
        const c = e as DwgEntity & { center: P; radius: number };
        if (Number.isFinite(c.radius) && c.radius > 0)
          poly(arcPoints(c.center.x, c.center.y, c.radius, 0, Math.PI * 2), color);
        break;
      }
      case "ARC": {
        const a = e as DwgEntity & {
          center: P;
          radius: number;
          startAngle: number;
          endAngle: number;
        };
        if (Number.isFinite(a.radius) && a.radius > 0)
          poly(arcPoints(a.center.x, a.center.y, a.radius, a.startAngle, a.endAngle), color);
        break;
      }
      case "TEXT":
      case "MTEXT": {
        const t = e as DwgEntity & {
          text: string;
          textHeight: number;
          rotation?: number;
          startPoint?: P;
          insertionPoint?: P;
        };
        const at = t.startPoint ?? t.insertionPoint;
        const text = plainText(t.text);
        if (!at || !text) break;
        const h = t.textHeight || 2.5;
        const deg = -((t.rotation ?? 0) * 180) / Math.PI; // in DWG la rotazione è in radianti
        ents.push({
          type: "text",
          x: at.x,
          y: -at.y - h,
          text,
          size: h,
          color,
          ...(deg ? { angle: deg } : {}),
        });
        break;
      }
      default:
        skipped[e.type] = (skipped[e.type] ?? 0) + 1;
    }
  }
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
