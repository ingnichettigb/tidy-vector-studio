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

  it("selection box takes entities inside it or crossing its border", () => {
    const L = new DrawingLayer(room);
    // box around everything but the wall rectangle's own outline: wall is not touched
    expect(L.touchRect({ x: 5, y: 5 }, { x: 95, y: 95 }).sort()).toEqual([1, 2, 3]);
    // box fully inside the room, in an empty spot: selects nothing (not the wall around it)
    expect(L.touchRect({ x: 40, y: 10 }, { x: 55, y: 15 })).toEqual([]);
    // box that only covers the left half of the horizontal line: partly inside still counts
    expect(L.touchRect({ x: 0, y: 45 }, { x: 30, y: 55 }).sort()).toEqual([0, 1]);
    // box crossing only the end of the polyline
    expect(L.touchRect({ x: 75, y: 55 }, { x: 95, y: 65 })).toEqual([3]);
  });

  it("selects a diagonal line that crosses the box without any end point inside", () => {
    const L = new DrawingLayer([
      { type: "line", x1: 0, y1: 0, x2: 100, y2: 100, color: "#111111" },
    ]);
    expect(L.touchRect({ x: 40, y: 40 }, { x: 60, y: 60 })).toEqual([0]);
    expect(L.touchRect({ x: 70, y: 10 }, { x: 90, y: 30 })).toEqual([]); // off the diagonal
  });

  it("selects text whose box overlaps the selection box", () => {
    const L = new DrawingLayer(room);
    expect(L.touchRect({ x: 40, y: 22 }, { x: 60, y: 30 })).toEqual([2]); // text spans x 20..44
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

describe("DrawingLayer undo / redo", () => {
  it("undoes and redoes a deletion, restoring the entities where they were", () => {
    const L = new DrawingLayer(room);
    L.selected.add(1);
    L.selected.add(2);
    L.removeSelected();
    expect(L.count).toBe(2);
    expect(L.canUndo).toBe(true);
    expect(L.undo()).toEqual({ kind: "remove", n: 2 });
    expect(L.count).toBe(4);
    expect(L.toEnts().map((e) => e.type)).toEqual(["rect", "line", "text", "poly"]);
    expect(L.hitAt(50, 50, 3)).toBe(1); // picking works again
    expect(L.redo()).toEqual({ kind: "remove", n: 2 });
    expect(L.count).toBe(2);
  });

  it("undoes an added entity and a whole eraser stroke as one step", () => {
    const L = new DrawingLayer(room);
    L.addUndoable({ type: "line", x1: 0, y1: 0, x2: 5, y2: 5, color: "#111111" });
    expect(L.count).toBe(5);
    expect(L.undo()).toEqual({ kind: "add", n: 1 });
    expect(L.count).toBe(4);
    // an eraser stroke removes several entities live, then records them once
    L.remove(1);
    L.remove(3);
    L.record("remove", [1, 3]);
    expect(L.undo()).toEqual({ kind: "remove", n: 2 });
    expect(L.count).toBe(4);
  });

  it("drops the redo history when a new change is made, and has nothing to undo on a new drawing", () => {
    const L = new DrawingLayer(room);
    L.selected.add(0);
    L.removeSelected();
    L.undo();
    expect(L.canRedo).toBe(true);
    L.addUndoable({ type: "line", x1: 0, y1: 0, x2: 1, y2: 1, color: "#111111" });
    expect(L.canRedo).toBe(false);
    expect(new DrawingLayer(room).canUndo).toBe(false);
    expect(new DrawingLayer().undo()).toBeNull();
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
