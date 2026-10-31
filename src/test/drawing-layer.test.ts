import { describe, expect, it } from "vitest";

import { toDxf, type Ent } from "@/components/cad/cad-data";
import { DrawingLayer } from "@/components/cad/drawing-layer";
import { parseDxf } from "@/components/cad/dxf-import";

const room: Ent[] = [
  { type: "rect", x: 0, y: 0, w: 100, h: 100, color: "#111111" }, // 0: wall rectangle
  { type: "line", x1: 10, y1: 50, x2: 90, y2: 50, color: "#ff4d4d" }, // 1
  { type: "text", x: 20, y: 20, text: "SALA", size: 10, color: "#c2410c" }, // 2
  {
    type: "poly",
    pts: [
      { x: 60, y: 60 },
      { x: 80, y: 60 },
      { x: 80, y: 80 },
    ],
    color: "#4da3ff",
  }, // 3
];

describe("DrawingLayer picking", () => {
  it("hits only near the stroke, so the inside of a rectangle is empty space", () => {
    const L = new DrawingLayer(room);
    expect(L.hitAt(50, 30, 3)).toBe(-1); // inside the room, away from everything
    expect(L.hitAt(0, 30, 3)).toBe(0); // on the wall
    expect(L.hitAt(50, 52, 3)).toBe(1); // 2 units from the line
    expect(L.hitAt(50, 56, 3)).toBe(-1); // 6 units away
  });

  it("hits text anywhere inside its box, and polylines on any segment", () => {
    const L = new DrawingLayer(room);
    expect(L.hitAt(30, 25, 1)).toBe(2);
    expect(L.hitAt(80, 70, 1)).toBe(3);
  });

  it("takes the topmost entity when several overlap", () => {
    const L = new DrawingLayer([
      { type: "line", x1: 0, y1: 0, x2: 10, y2: 0, color: "#111111" },
      { type: "line", x1: 0, y1: 0, x2: 10, y2: 0, color: "#ff4d4d" },
    ]);
    expect(L.hitAt(5, 0, 2)).toBe(1);
  });

  it("window selection takes only entities fully inside the box", () => {
    const L = new DrawingLayer(room);
    // box around the text and the line, but not the wall rectangle around them
    const ids = L.insideRect({ x: 5, y: 5 }, { x: 95, y: 95 });
    expect(ids.sort()).toEqual([1, 2, 3]);
    expect(L.insideRect({ x: 15, y: 15 }, { x: 50, y: 40 })).toEqual([2]);
  });
});

describe("DrawingLayer editing", () => {
  it("removes the selection and keeps indexes stable", () => {
    const L = new DrawingLayer(room);
    L.selected.add(1);
    L.selected.add(2);
    expect(L.removeSelected()).toBe(2);
    expect(L.count).toBe(2);
    expect(L.toEnts().map((e) => e.type)).toEqual(["rect", "poly"]);
    expect(L.hitAt(50, 50, 3)).toBe(-1);
    expect(L.hitAt(80, 70, 1)).toBe(3);
  });

  it("computes the bounds of what is left", () => {
    const L = new DrawingLayer(room);
    expect(L.bounds()).toEqual({ x1: 0, y1: 0, x2: 100, y2: 100 });
    L.remove(0);
    expect(L.bounds()).toMatchObject({ x1: 10, x2: 90 });
    expect(new DrawingLayer().bounds()).toBeNull();
  });
});

describe("DXF round trip", () => {
  it("exports lines, polylines, rectangles and text, and reads them back", () => {
    const dxf = toDxf(room);
    const back = parseDxf(dxf);
    // rect -> 4 lines, line -> 1, poly (3 points) -> 2 lines, text -> 1
    expect(back.filter((e) => e.type === "line")).toHaveLength(7);
    expect(back.filter((e) => e.type === "text")).toHaveLength(1);
  });

  it("imports a polyline as one entity, not one per segment", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ["10", String(i), "20", String(i % 7)]).flat();
    const dxf = [
      ...["0", "SECTION", "2", "ENTITIES", "0", "LWPOLYLINE", "8", "0", "90", "50", "70", "0"],
      ...pts,
      ...["0", "ENDSEC", "0", "EOF"],
    ].join("\n");
    const ents = parseDxf(dxf);
    expect(ents).toHaveLength(1);
    expect(ents[0]).toMatchObject({ type: "poly" });
  });
});
