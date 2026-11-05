/**
 * =======================================================================
 * File:        dwg-curves.test.ts
 * Percorso:    (src/test/dwg-curves.test.ts)
 * Revisione:   Rev. 1.0
 * Data:        05/11/2026
 * -----------------------------------------------------------------------
 * Storico Revisioni (max 10 voci, oltre la decima si sostituisce la più vecchia):
 * [05/11/2026] Rev. 1.0 - Prove di dwg-import: blocchi (INSERT), quote (DIMENSION),
 *                         polilinee 2D, ellissi, spline, solidi, leader
 * =======================================================================
 */

import { describe, expect, it } from "vitest";
import type { DwgDatabase } from "@mlightcad/libredwg-web";

import type { Ent } from "@/components/cad/cad-data";
import { convertDatabase } from "@/components/cad/dwg-import";

const P = (x: number, y: number) => ({ x, y, z: 0 });
// Un database finto con solo i campi che l'importatore legge.
const db = (entities: object[], layers: object[] = []) =>
  ({ tables: { LAYER: { entries: layers } }, entities }) as unknown as DwgDatabase;
const base = { layer: "0", colorIndex: 1 };

/* ---------- blocchi, quote e curve (Rev. 1.1) ---------- */
type Poly = Extract<Ent, { type: "poly" }>;
const dbBlocks = (entities: object[], blocks: Record<string, object>) =>
  ({
    tables: {
      LAYER: { entries: [{ name: "MURI", colorIndex: 5, off: false, frozen: false }] },
      BLOCK_RECORD: {
        entries: [
          { name: "*Model_Space", entities: [] },
          ...Object.entries(blocks).map(([name, b]) => ({ name, ...b })),
        ],
      },
    },
    entities,
  }) as unknown as DwgDatabase;
const seg = { type: "LINE", layer: "0", colorIndex: 256, startPoint: P(0, 0), endPoint: P(10, 0) };
const ins = (name: string, extra: object = {}) => ({
  type: "INSERT",
  layer: "MURI",
  colorIndex: 256,
  name,
  insertionPoint: P(100, 50),
  xScale: 1,
  yScale: 1,
  rotation: 0,
  columnCount: 1,
  rowCount: 1,
  columnSpacing: 0,
  rowSpacing: 0,
  ...extra,
});

describe("INSERT (blocchi)", () => {
  it("espande il blocco spostandolo nel punto di inserimento, tolto il punto base", () => {
    const r = convertDatabase(dbBlocks([ins("B")], { B: { basePoint: P(2, 0), entities: [seg] } }));
    expect(r.ents[0]).toMatchObject({ type: "line", x1: 98, x2: 108, y1: -50 });
  });

  it("applica scala e rotazione (90°: l'asse X del blocco diventa l'asse Y)", () => {
    const r = convertDatabase(
      dbBlocks([ins("B", { xScale: 2, yScale: 2, rotation: Math.PI / 2 })], {
        B: { entities: [seg] },
      }),
    );
    const l = r.ents[0] as Extract<Ent, { type: "line" }>;
    expect(l.x1).toBeCloseTo(100, 6);
    expect(l.x2).toBeCloseTo(100, 6); // lungo Y
    expect(l.y1).toBeCloseTo(-50, 6);
    expect(l.y2).toBeCloseTo(-70, 6); // 10 unità * scala 2, verso l'alto (Y capovolta)
  });

  it("espande anche i blocchi dentro i blocchi, componendo le trasformazioni", () => {
    const r = convertDatabase(
      dbBlocks([ins("A")], {
        A: { entities: [ins("B", { insertionPoint: P(5, 0), layer: "0" })] },
        B: { entities: [seg] },
      }),
    );
    expect(r.ents).toHaveLength(1);
    expect(r.ents[0]).toMatchObject({ x1: 105, x2: 115 });
  });

  it("una matrice 2x3 dà 6 copie distanziate", () => {
    const r = convertDatabase(
      dbBlocks([ins("B", { columnCount: 3, rowCount: 2, columnSpacing: 20, rowSpacing: 30 })], {
        B: { entities: [seg] },
      }),
    );
    expect(r.ents).toHaveLength(6);
    const xs = r.ents.map((e) => (e as Extract<Ent, { type: "line" }>).x1);
    expect(new Set(xs)).toEqual(new Set([100, 120, 140]));
  });

  it("sul layer 0 e DA BLOCCO le entità prendono layer e colore dell'INSERT", () => {
    const r = convertDatabase(
      dbBlocks([ins("B")], {
        B: {
          entities: [
            { ...seg, colorIndex: 256 }, // da layer "0" -> layer MURI (blu)
            { ...seg, colorIndex: 0 }, // da blocco -> colore dell'INSERT (blu, da MURI)
            { ...seg, colorIndex: 1 }, // colore proprio: resta rosso
          ],
        },
      }),
    );
    expect(r.ents.map((e) => e.color)).toEqual(["#4da3ff", "#4da3ff", "#ff4d4d"]);
  });

  it("un blocco che non esiste conta come INSERT non supportato; i cicli non bloccano", () => {
    expect(convertDatabase(dbBlocks([ins("MANCA")], {})).skipped).toEqual({ INSERT: 1 });
    const loop = convertDatabase(dbBlocks([ins("A")], { A: { entities: [ins("A"), seg] } }));
    expect(loop.ents.length).toBeLessThan(20); // si ferma alla profondità massima
  });

  it("scrive gli attributi dell'INSERT come testi", () => {
    const r = convertDatabase(
      dbBlocks(
        [
          ins("B", {
            attribs: [
              {
                layer: "0",
                flags: 0,
                text: { text: "REV A", startPoint: P(1, 2), textHeight: 3, rotation: 0 },
              },
              {
                layer: "0",
                flags: 1,
                text: { text: "NASCOSTO", startPoint: P(1, 2), textHeight: 3, rotation: 0 },
              },
            ],
          }),
        ],
        { B: { entities: [] } },
      ),
    );
    expect(r.ents).toHaveLength(1);
    expect(r.ents[0]).toMatchObject({ type: "text", text: "REV A", size: 3 });
  });

  it("le quote (DIMENSION) si disegnano dal loro blocco anonimo", () => {
    const r = convertDatabase(
      dbBlocks([{ type: "DIMENSION", layer: "0", colorIndex: 1, name: "*D1" }], {
        "*D1": {
          entities: [
            seg,
            {
              type: "MTEXT",
              layer: "0",
              colorIndex: 1,
              text: "8.00",
              textHeight: 2,
              insertionPoint: P(5, 1),
            },
          ],
        },
      }),
    );
    expect(r.ents.map((e) => e.type)).toEqual(["line", "text"]);
    expect(
      convertDatabase(dbBlocks([{ type: "DIMENSION", layer: "0", name: "*Dx" }], {})).skipped,
    ).toEqual({
      DIMENSION: 1,
    });
  });
});

describe("polilinee 2D, ellissi, spline, solidi", () => {
  it("POLYLINE2D: un'unica polilinea, chiusa col flag, senza i punti di controllo", () => {
    const v = (x: number, y: number, flag = 0) => ({ ...P(x, y), flag, bulge: 0 });
    const r = convertDatabase(
      db([
        {
          ...base,
          type: "POLYLINE2D",
          flag: 1,
          vertices: [v(0, 0), v(10, 0), v(10, 10), v(99, 99, 16)],
        },
      ]),
    );
    const pts = (r.ents[0] as Poly).pts;
    expect(pts).toHaveLength(4); // 3 vertici veri + il ritorno al primo
    expect(pts.some((p) => p.x === 99)).toBe(false);
    expect(
      convertDatabase(db([{ ...base, type: "POLYLINE2D", flag: 64, vertices: [] }])).skipped,
    ).toEqual({
      POLYFACE: 1,
    });
  });

  it("ELLIPSE: ogni punto sta sull'ellisse, e l'arco parziale si ferma a metà", () => {
    const e = {
      ...base,
      type: "ELLIPSE",
      center: P(0, 0),
      majorAxisEndPoint: P(10, 0),
      axisRatio: 0.5,
    };
    const full = convertDatabase(db([{ ...e, startAngle: 0, endAngle: 2 * Math.PI }]));
    for (const p of (full.ents[0] as Poly).pts)
      expect((p.x / 10) ** 2 + (p.y / 5) ** 2).toBeCloseTo(1, 6);
    const half = (convertDatabase(db([{ ...e, startAngle: 0, endAngle: Math.PI }])).ents[0] as Poly)
      .pts;
    expect(half[0]!.x).toBeCloseTo(10, 6);
    expect(half.at(-1)!.x).toBeCloseTo(-10, 6);
  });

  it("SPLINE: la curva di Bézier quadratica passa per il punto giusto e tocca gli estremi", () => {
    const sp = {
      ...base,
      type: "SPLINE",
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      controlPoints: [P(0, 0), P(5, 10), P(10, 0)],
      fitPoints: [],
    };
    const pts = (convertDatabase(db([sp])).ents[0] as Poly).pts;
    expect(pts[0]).toMatchObject({ x: 0, y: -0 });
    expect(pts.at(-1)!.x).toBeCloseTo(10, 4);
    const mid = pts[Math.floor(pts.length / 2)]!; // t = 0.5 -> (5, 5), con la Y capovolta
    expect(mid.x).toBeCloseTo(5, 6);
    expect(mid.y).toBeCloseTo(-5, 6);
    // senza nodi validi: ripiega sulla poligonale di controllo
    const bad = convertDatabase(db([{ ...sp, knots: [] }])).ents[0] as Poly;
    expect(bad.pts).toHaveLength(3);
  });

  it("SOLID: contorno nell'ordine 1, 2, 4, 3; 3DFACE nell'ordine 1, 2, 3, 4", () => {
    const c = { corner1: P(0, 0), corner2: P(10, 0), corner3: P(0, 10), corner4: P(10, 10) };
    const solid = (convertDatabase(db([{ ...base, type: "SOLID", ...c }])).ents[0] as Poly).pts;
    expect(solid.map((p) => [p.x, -p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
    const face = (convertDatabase(db([{ ...base, type: "3DFACE", ...c }])).ents[0] as Poly).pts;
    expect(face.map((p) => [p.x, -p.y])).toEqual([
      [0, 0],
      [10, 0],
      [0, 10],
      [10, 10],
      [0, 0],
    ]);
  });

  it("LEADER diventa una polilinea", () => {
    const r = convertDatabase(
      db([{ ...base, type: "LEADER", vertices: [P(0, 0), P(5, 5), P(9, 5)] }]),
    );
    expect((r.ents[0] as Poly).pts).toHaveLength(3);
  });
});
