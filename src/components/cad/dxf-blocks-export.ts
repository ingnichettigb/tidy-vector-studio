/**
 * =======================================================================
 * File:        dxf-blocks-export.ts
 * Percorso:    (src/components/cad/dxf-blocks-export.ts)
 * Revisione:   Rev. 1.0
 * Data:        05/11/2026
 * -----------------------------------------------------------------------
 * Storico Revisioni (max 10 voci, oltre la decima si sostituisce la più vecchia):
 * [05/11/2026] Rev. 1.0 - Esportatore DXF R2000 a parte, con sezioni HEADER, TABLES
 *                         (LTYPE, LAYER, STYLE, BLOCK_RECORD), BLOCKS ed ENTITIES, con
 *                         handle. Usato solo dal pulsante "Scarica come DXF": `toDxf` in
 *                         cad-data.ts resta com'è e continua a servire "Esporta DXF".
 * =======================================================================
 */

import {
  DOT_FACTOR,
  PALETTE,
  leaderStart,
  markerFontSize,
  widthToLineweight,
  type Ent,
} from "./cad-data";

/** Layer dei numeri cerchiati, uguale a quello di `toDxf` (si può spegnere in qualsiasi CAD). */
const NUMBERS_LAYER = "NUMERI";

// Colore (esadecimale dell'editor) -> indice ACI. Oltre alla palette a 5 colori ci sono quelli
// che arrivano da DXF/DWG importati (stessi valori di dxf-import.ts e dwg-import.ts).
const HEX_TO_ACI: Record<string, number> = {
  "#ff4d4d": 1,
  "#b8860b": 2,
  "#3ddc84": 3,
  "#3dd6dc": 4,
  "#4da3ff": 5,
  "#e05cff": 6,
  "#111111": 7,
  "#8a8a8a": 8,
  "#777777": 9,
};
for (const p of PALETTE) HEX_TO_ACI[p.value.toLowerCase()] = p.aci;

const aci = (color: string) => HEX_TO_ACI[color?.toLowerCase()] ?? 7;
const num = (v: number) => v.toFixed(3);

export function drawingToDxf(ents: Ent[], opts: { numbersOff?: boolean } = {}): string {
  /* ---- handle: ogni oggetto ne ha uno univoco, in esadecimale ---- */
  let last = 0;
  const handle = () => (++last).toString(16).toUpperCase();

  let out: string[] = []; // sezione in scrittura: coppie riga-codice, riga-valore
  const g = (code: number, value: string | number) => out.push(String(code), String(value));

  /* ---- gli oggetti che gli altri richiamano per handle ---- */
  const hLtypeTable = handle(),
    hLayerTable = handle(),
    hStyleTable = handle(),
    hBlockRecTable = handle();
  const hModelRec = handle(),
    hPaperRec = handle();

  /* ---- TABLES ---- */
  const tables: string[] = [];
  out = tables;
  g(0, "SECTION");
  g(2, "TABLES");

  const table = (name: string, h: string, count: number, entries: () => void) => {
    g(0, "TABLE");
    g(2, name);
    g(5, h);
    g(330, 0);
    g(100, "AcDbSymbolTable");
    g(70, count);
    entries();
    g(0, "ENDTAB");
  };
  const record = (type: string, h: string, owner: string, sub: string, name: string) => {
    g(0, type);
    g(5, h);
    g(330, owner);
    g(100, "AcDbSymbolTableRecord");
    g(100, sub);
    g(2, name);
  };

  table("LTYPE", hLtypeTable, 3, () => {
    for (const [name, desc] of [
      ["ByBlock", ""],
      ["ByLayer", ""],
      ["Continuous", "Solid line"],
    ] as const) {
      record("LTYPE", handle(), hLtypeTable, "AcDbLinetypeTableRecord", name);
      g(70, 0);
      g(3, desc);
      g(72, 65);
      g(73, 0);
      g(40, "0.0");
    }
  });
  table("LAYER", hLayerTable, 2, () => {
    for (const [name, color] of [
      ["0", 7],
      [NUMBERS_LAYER, opts.numbersOff ? -7 : 7], // colore negativo = layer spento
    ] as const) {
      record("LAYER", handle(), hLayerTable, "AcDbLayerTableRecord", name);
      g(70, 0);
      g(62, color);
      g(6, "Continuous");
    }
  });
  table("STYLE", hStyleTable, 1, () => {
    record("STYLE", handle(), hStyleTable, "AcDbTextStyleTableRecord", "Standard");
    g(70, 0);
    g(40, "0.0");
    g(41, "1.0");
    g(50, "0.0");
    g(71, 0);
    g(42, "2.5");
    g(3, "txt");
    g(4, "");
  });
  table("BLOCK_RECORD", hBlockRecTable, 2, () => {
    record("BLOCK_RECORD", hModelRec, hBlockRecTable, "AcDbBlockTableRecord", "*Model_Space");
    record("BLOCK_RECORD", hPaperRec, hBlockRecTable, "AcDbBlockTableRecord", "*Paper_Space");
  });
  g(0, "ENDSEC");

  /* ---- BLOCKS: i due blocchi di sistema (il disegno vero sta in ENTITIES, nello spazio modello) ---- */
  const blocks: string[] = [];
  out = blocks;
  g(0, "SECTION");
  g(2, "BLOCKS");
  for (const [name, rec, paper] of [
    ["*Model_Space", hModelRec, false],
    ["*Paper_Space", hPaperRec, true],
  ] as const) {
    g(0, "BLOCK");
    g(5, handle());
    g(330, rec);
    g(100, "AcDbEntity");
    if (paper) g(67, 1);
    g(8, "0");
    g(100, "AcDbBlockBegin");
    g(2, name);
    g(70, 0);
    g(10, "0.0");
    g(20, "0.0");
    g(30, "0.0");
    g(3, name);
    g(1, "");
    g(0, "ENDBLK");
    g(5, handle());
    g(330, rec);
    g(100, "AcDbEntity");
    if (paper) g(67, 1);
    g(8, "0");
    g(100, "AcDbBlockEnd");
  }
  g(0, "ENDSEC");

  /* ---- ENTITIES (spazio modello) ---- */
  const entities: string[] = [];
  out = entities;
  g(0, "SECTION");
  g(2, "ENTITIES");

  const entity = (type: string, sub: string, c: number, w?: number, layer = "0") => {
    g(0, type);
    g(5, handle());
    g(330, hModelRec);
    g(100, "AcDbEntity");
    g(8, layer);
    g(62, c);
    if (w) g(370, widthToLineweight(w));
    g(100, sub);
  };
  const point = (a: number, x: number, y: number) => {
    g(10 + a, num(x));
    g(20 + a, num(-y)); // l'editor ha la Y verso il basso, il CAD verso l'alto
    g(30 + a, "0.0");
  };
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    c: number,
    w?: number,
    layer = "0",
  ) => {
    entity("LINE", "AcDbLine", c, w, layer);
    point(0, x1, y1);
    point(1, x2, y2);
  };
  const lwpoly = (pts: { x: number; y: number }[], closed: boolean, c: number, w?: number) => {
    entity("LWPOLYLINE", "AcDbPolyline", c, w);
    g(90, pts.length);
    g(70, closed ? 1 : 0);
    for (const p of pts) {
      g(10, num(p.x));
      g(20, num(-p.y));
    }
  };

  for (const e of ents) {
    if (e.type === "line") {
      line(e.x1, e.y1, e.x2, e.y2, aci(e.color), e.w);
    } else if (e.type === "poly") {
      // l'importatore chiude una polilinea ripetendo il primo punto in coda: qui torna un flag
      const p = e.pts;
      const a = p[0]!,
        z = p[p.length - 1]!;
      const closed = p.length > 2 && Math.hypot(a.x - z.x, a.y - z.y) < 1e-6; // i cerchi: 1e-14 di scarto
      lwpoly(closed ? p.slice(0, -1) : p, closed, aci(e.color), e.w);
    } else if (e.type === "rect") {
      const r = e.x + e.w,
        b = e.y + e.h;
      lwpoly(
        [
          { x: e.x, y: e.y },
          { x: r, y: e.y },
          { x: r, y: b },
          { x: e.x, y: b },
        ],
        true,
        aci(e.color),
        e.sw,
      );
    } else if (e.type === "marker") {
      const c = aci(e.color);
      entity("CIRCLE", "AcDbCircle", c, e.w, NUMBERS_LAYER);
      point(0, e.x, e.y);
      g(40, num(e.r));
      // il numero, centrato nel cerchio (72 = centro, 73 = a metà altezza)
      entity("TEXT", "AcDbText", c, undefined, NUMBERS_LAYER);
      point(0, e.x, e.y);
      g(40, num(markerFontSize(e.r, e.n) * 0.8));
      g(1, e.n);
      g(72, 1);
      point(1, e.x, e.y);
      g(100, "AcDbText");
      g(73, 2);
      // linea guida verso il punto indicato, con un puntino in fondo
      const from = leaderStart(e);
      if (from && e.tx !== undefined && e.ty !== undefined) {
        line(from[0], from[1], e.tx, e.ty, c, e.w, NUMBERS_LAYER);
        entity("CIRCLE", "AcDbCircle", c, e.w, NUMBERS_LAYER);
        point(0, e.tx, e.ty);
        g(40, num(e.r * DOT_FACTOR));
      }
    } else {
      entity("TEXT", "AcDbText", aci(e.color));
      point(0, e.x, e.y + e.size);
      g(40, num(e.size * 0.8));
      g(1, e.text);
      g(50, num(-(e.angle || 0)));
      g(100, "AcDbText");
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");

  /* ---- HEADER per ultimo: $HANDSEED deve superare tutti gli handle usati ---- */
  const header: string[] = [];
  out = header;
  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$ACADVER");
  g(1, "AC1015");
  g(9, "$HANDSEED");
  g(5, (last + 1).toString(16).toUpperCase());
  g(9, "$LWDISPLAY");
  g(290, 1);
  g(0, "ENDSEC");

  return [...header, ...tables, ...blocks, ...entities].join("\n") + "\n";
}
