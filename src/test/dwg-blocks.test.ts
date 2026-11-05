/**
 * =======================================================================
 * File:        dwg-blocks.test.ts
 * Percorso:    (src/test/dwg-blocks.test.ts)
 * Revisione:   Rev. 1.0
 * Data:        05/11/2026
 * -----------------------------------------------------------------------
 * Storico Revisioni (max 10 voci, oltre la decima si sostituisce la più vecchia):
 * [05/11/2026] Rev. 1.0 - Prove di dwg-import (conversione database, controllo file) e di
 *                         dxf-blocks-export (struttura, handle, andata e ritorno col parser)
 * =======================================================================
 */

import { describe, expect, it } from "vitest";
import type { DwgDatabase } from "@mlightcad/libredwg-web";

import { buildMockDrawing, toDxf, type Ent } from "@/components/cad/cad-data";
import { drawingToDxf } from "@/components/cad/dxf-blocks-export";
import { convertDatabase, looksLikeDwg, parseDwg, plainText } from "@/components/cad/dwg-import";
import { parseDxf } from "@/components/cad/dxf-import";

const P = (x: number, y: number) => ({ x, y, z: 0 });
// Un database finto con solo i campi che l'importatore legge.
const db = (entities: object[], layers: object[] = []) =>
  ({ tables: { LAYER: { entries: layers } }, entities }) as unknown as DwgDatabase;
const base = { layer: "0", colorIndex: 1 };

describe("convertDatabase (DWG -> entità)", () => {
  it("converte LINE con la Y capovolta e il colore ACI", () => {
    const r = convertDatabase(
      db([{ ...base, type: "LINE", startPoint: P(0, 0), endPoint: P(10, 5) }]),
    );
    expect(r.ents).toEqual([{ type: "line", x1: 0, y1: -0, x2: 10, y2: -5, color: "#ff4d4d" }]);
  });

  it("LWPOLYLINE: una sola polilinea, chiusa col flag & 1, aperta altrimenti", () => {
    const v = [P(0, 0), P(10, 0), P(10, 10)];
    const open = convertDatabase(db([{ ...base, type: "LWPOLYLINE", flag: 0, vertices: v }]));
    const closed = convertDatabase(db([{ ...base, type: "LWPOLYLINE", flag: 1, vertices: v }]));
    expect(open.ents).toHaveLength(1);
    expect(open.ents[0]).toMatchObject({ type: "poly" });
    expect((open.ents[0] as Extract<Ent, { type: "poly" }>).pts).toHaveLength(3);
    const c = (closed.ents[0] as Extract<Ent, { type: "poly" }>).pts;
    expect(c).toHaveLength(4);
    expect(c[3]).toEqual(c[0]); // chiusa: l'ultimo punto torna al primo
    // due soli vertici: una linea
    expect(
      convertDatabase(db([{ ...base, type: "LWPOLYLINE", flag: 1, vertices: [P(0, 0), P(1, 1)] }]))
        .ents[0],
    ).toMatchObject({ type: "line" });
  });

  it("LWPOLYLINE con bulge: il lato diventa un arco che passa per il punto giusto", () => {
    // bulge 1 = semicerchio antiorario da (0,0) a (10,0): centro (5,0), raggio 5, passa per (5,-5)
    const r = convertDatabase(
      db([
        {
          ...base,
          type: "LWPOLYLINE",
          flag: 0,
          vertices: [{ ...P(0, 0), bulge: 1 }, P(10, 0)],
        },
      ]),
    );
    const pts = (r.ents[0] as Extract<Ent, { type: "poly" }>).pts;
    expect(pts.length).toBeGreaterThan(8);
    for (const p of pts) expect(Math.hypot(p.x - 5, p.y)).toBeCloseTo(5, 6);
    expect(pts.some((p) => Math.abs(p.x - 5) < 1e-6 && Math.abs(p.y - 5) < 1e-6)).toBe(true);
  });

  it("CIRCLE e ARC (angoli in radianti) diventano polilinee sul raggio giusto", () => {
    const r = convertDatabase(
      db([
        { ...base, type: "CIRCLE", center: P(100, 50), radius: 20 },
        { ...base, type: "ARC", center: P(0, 0), radius: 10, startAngle: 0, endAngle: Math.PI / 2 },
      ]),
    );
    const circle = (r.ents[0] as Extract<Ent, { type: "poly" }>).pts;
    for (const p of circle) expect(Math.hypot(p.x - 100, p.y + 50)).toBeCloseTo(20, 6);
    expect(circle[0]!.x).toBeCloseTo(circle[circle.length - 1]!.x, 6);
    expect(circle[0]!.y).toBeCloseTo(circle[circle.length - 1]!.y, 6);
    const arc = (r.ents[1] as Extract<Ent, { type: "poly" }>).pts;
    expect(arc[0]!.x).toBeCloseTo(10, 6);
    expect(arc[arc.length - 1]!.y).toBeCloseTo(-10, 6); // 90° antiorari, Y capovolta
  });

  it("TEXT e MTEXT: pulisce i codici, converte la rotazione in gradi", () => {
    const r = convertDatabase(
      db([
        {
          ...base,
          type: "TEXT",
          text: "BAGNO",
          textHeight: 12,
          startPoint: P(5, 5),
          rotation: Math.PI / 2,
        },
        {
          ...base,
          type: "MTEXT",
          text: "\\fArial|b1;SALA\\P%%c20",
          textHeight: 0,
          insertionPoint: P(1, 2),
        },
      ]),
    );
    expect(r.ents[0]).toMatchObject({ type: "text", text: "BAGNO", size: 12, x: 5, y: -17 });
    expect((r.ents[0] as Extract<Ent, { type: "text" }>).angle).toBeCloseTo(-90, 6);
    expect(r.ents[1]).toMatchObject({ text: "SALA Ø20", size: 2.5 }); // altezza 0 -> valore di riserva
    expect(plainText("{\\C1;rosso}")).toBe("rosso");
  });

  it("scarta lo Spazio Carta, gli invisibili e i layer spenti, e conta i tipi non supportati", () => {
    const line = { ...base, type: "LINE", startPoint: P(0, 0), endPoint: P(1, 1) };
    const r = convertDatabase(
      db(
        [
          line,
          { ...line, isInPaperSpace: true },
          { ...line, isVisible: false },
          { ...line, layer: "SPENTO" },
          { ...base, type: "INSERT" },
          { ...base, type: "INSERT" },
          { ...base, type: "HATCH" },
        ],
        [{ name: "SPENTO", colorIndex: 3, off: true, frozen: false }],
      ),
    );
    expect(r.ents).toHaveLength(1);
    expect(r.ignored).toBe(3);
    expect(r.skipped).toEqual({ INSERT: 2, HATCH: 1 });
  });

  it("il colore DA LAYER (256) prende quello del layer", () => {
    const r = convertDatabase(
      db(
        [{ type: "LINE", layer: "MURI", colorIndex: 256, startPoint: P(0, 0), endPoint: P(1, 0) }],
        [{ name: "MURI", colorIndex: 5, off: false, frozen: false }],
      ),
    );
    expect(r.ents[0]).toMatchObject({ color: "#4da3ff" });
  });
});

describe("controllo del file DWG", () => {
  const bytes = (s: string) => new TextEncoder().encode(s + "xxxx").buffer as ArrayBuffer;

  it("riconosce l'intestazione di versione e rifiuta il resto", () => {
    expect(looksLikeDwg(bytes("AC1015"))).toBe(true);
    expect(looksLikeDwg(bytes("AC1032"))).toBe(true);
    expect(looksLikeDwg(bytes("  0\nSECTION"))).toBe(false); // un DXF
    expect(looksLikeDwg(new ArrayBuffer(0))).toBe(false);
  });

  it("parseDwg rifiuta un file che non è un DWG senza avviare il WebAssembly", async () => {
    await expect(parseDwg(bytes("PK\u0003\u0004zip"))).rejects.toThrow("non è un DWG valido");
  });

  // vale solo finché src/assets/libredwg-web.wasm.asset.json non esiste (poi il test non ha senso)
  const hasAsset = Object.keys(
    import.meta.glob("../assets/libredwg-web.wasm.asset.json", { eager: true }),
  ).length;
  it.skipIf(hasAsset > 0)(
    "senza il puntatore asset dà un errore che spiega cosa fare",
    async () => {
      await expect(parseDwg(bytes("AC1015"))).rejects.toThrow("gestore asset di Lovable");
    },
  );
});

describe("drawingToDxf (DXF a parte con BLOCKS)", () => {
  const ents: Ent[] = [
    ...buildMockDrawing(0),
    { type: "line", x1: 0, y1: 0, x2: 50, y2: 0, color: "#ff4d4d", w: 5 },
    {
      type: "poly",
      pts: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 0 },
      ],
      color: "#4da3ff",
      w: 2,
    },
    { type: "marker", x: 50, y: 20, r: 8, n: "03", color: "#ff4d4d", w: 2, tx: 90, ty: 20 },
    { type: "text", x: 5, y: 5, text: "RUOTATO", size: 10, color: "#111111", angle: -90 },
  ];
  const rows = drawingToDxf(ents).split("\n");
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) pairs.push([rows[i]!, rows[i + 1]!]);

  it("ha le sezioni nell'ordine HEADER, TABLES, BLOCKS, ENTITIES e finisce con EOF", () => {
    const sections = pairs.filter(([c], i) => c === "2" && pairs[i - 1]?.[1] === "SECTION");
    expect(sections.map(([, v]) => v)).toEqual(["HEADER", "TABLES", "BLOCKS", "ENTITIES"]);
    expect(pairs.at(-1)).toEqual(["0", "EOF"]);
    expect(pairs.filter(([c, v]) => c === "0" && v === "SECTION")).toHaveLength(4);
    expect(pairs.filter(([c, v]) => c === "0" && v === "ENDSEC")).toHaveLength(4);
  });

  it("BLOCKS contiene i blocchi di sistema, ognuno con il suo ENDBLK", () => {
    const names = pairs.filter(([c], i) => c === "2" && pairs[i - 1]?.[1] === "AcDbBlockBegin");
    expect(names.map(([, v]) => v)).toEqual(["*Model_Space", "*Paper_Space"]);
    expect(pairs.filter(([c, v]) => c === "0" && v === "ENDBLK")).toHaveLength(2);
  });

  it("gli handle sono tutti diversi e $HANDSEED è più grande del massimo", () => {
    const start = pairs.findIndex(([c, v]) => c === "2" && v === "TABLES"); // dopo l'HEADER
    const handles = pairs
      .slice(start)
      .filter(([c]) => c === "5")
      .map(([, v]) => v);
    expect(new Set(handles).size).toBe(handles.length);
    const seed = parseInt(pairs[pairs.findIndex(([, v]) => v === "$HANDSEED") + 1]![1], 16);
    for (const h of handles) expect(parseInt(h, 16)).toBeLessThan(seed);
  });

  it("scrive polilinee LWPOLYLINE (la chiusa col flag 70 = 1) e salva gli spessori", () => {
    // il triangolo dell'esempio ha 4 punti con il primo ripetuto in coda: 3 vertici + flag chiusa
    const k = pairs.findIndex(([c, v], i) => c === "90" && v === "3" && pairs[i + 1]![0] === "70");
    expect(pairs[k + 1]).toEqual(["70", "1"]);
    expect(pairs.some(([c]) => c === "370")).toBe(true);
  });

  it("riletto dal parser dà le stesse forme: niente si perde", () => {
    const back = parseDxf(drawingToDxf(ents));
    const count = (t: string) => back.filter((e) => e.type === t).length;
    // 1 linea + (rect -> LWPOLYLINE chiuse) ... ; si confronta con il DXF di sempre
    const old = parseDxf(toDxf(ents));
    expect(count("text")).toBe(old.filter((e) => e.type === "text").length);
    expect(back.find((e) => e.type === "text" && e.text === "RUOTATO")).toMatchObject({
      angle: -90,
    });
    expect(back.length).toBeGreaterThan(0);
  });

  it("lo spegnimento del layer NUMERI si porta nel file", () => {
    const off = drawingToDxf(ents, { numbersOff: true }).split("\n");
    const k = off.indexOf("NUMERI");
    expect(off.slice(k + 1, k + 5)).toEqual(["70", "0", "62", "-7"]);
  });
});
