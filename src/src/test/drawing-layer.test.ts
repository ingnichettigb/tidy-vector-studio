import { describe, expect, it } from "vitest";

import {
  THICKNESS,
  entWidth,
  lineweightToWidth,
  toDxf,
  widthToLineweight,
  type Ent,
} from "@/components/cad/cad-data";
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

  it("window selection (left to right) takes only what is entirely inside the box", () => {
    const L = new DrawingLayer(room);
    // the whole room: everything is inside, the wall rectangle included
    expect(L.insideRect({ x: -5, y: -5 }, { x: 105, y: 105 }).sort()).toEqual([0, 1, 2, 3]);
    // box around the line but cutting the wall rectangle: only the line is entirely inside
    expect(L.insideRect({ x: 5, y: 40 }, { x: 95, y: 60 })).toEqual([1]);
    // a box that only covers half of the line takes nothing, unlike the crossing selection
    expect(L.insideRect({ x: 0, y: 45 }, { x: 30, y: 55 })).toEqual([]);
    expect(L.touchRect({ x: 0, y: 45 }, { x: 30, y: 55 }).sort()).toEqual([0, 1]);
    // text must be fully inside too (it spans x 20..44)
    expect(L.insideRect({ x: 15, y: 15 }, { x: 40, y: 40 })).toEqual([]);
    expect(L.insideRect({ x: 15, y: 15 }, { x: 50, y: 40 })).toEqual([2]);
  });

  it("the drag direction does not matter for the corners, only the box does", () => {
    const L = new DrawingLayer(room);
    expect(L.insideRect({ x: 95, y: 60 }, { x: 5, y: 40 })).toEqual([1]);
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

describe("circled numbers (markers)", () => {
  const marker: Ent = { type: "marker", x: 50, y: 50, r: 10, n: "07", color: "#ff4d4d", w: 3 };

  it("is clickable anywhere on its disc, and bounded by its circle", () => {
    const L = new DrawingLayer([marker]);
    expect(L.hitAt(50, 50, 2)).toBe(0); // centre, over the number
    expect(L.hitAt(58, 50, 2)).toBe(0);
    expect(L.hitAt(65, 50, 2)).toBe(-1);
    expect(L.bounds()).toEqual({ x1: 40, y1: 40, x2: 60, y2: 60 });
  });

  it("is picked by the selection boxes like any other element", () => {
    const L = new DrawingLayer([marker]);
    expect(L.touchRect({ x: 55, y: 45 }, { x: 80, y: 55 })).toEqual([0]);
    expect(L.insideRect({ x: 55, y: 45 }, { x: 80, y: 55 })).toEqual([]);
    expect(L.insideRect({ x: 30, y: 30 }, { x: 70, y: 70 })).toEqual([0]);
  });

  it("can be placed, undone and redone like a drawn line", () => {
    const L = new DrawingLayer();
    L.addUndoable(marker);
    expect(L.count).toBe(1);
    expect(L.undo()).toEqual({ kind: "add", n: 1 });
    expect(L.count).toBe(0);
    expect(L.redo()).toEqual({ kind: "add", n: 1 });
    expect(L.count).toBe(1);
  });
});

describe("line thickness", () => {
  it("changes only the selected elements that have a thickness, and undoes it", () => {
    const L = new DrawingLayer(room);
    L.selected.add(0); // rect
    L.selected.add(1); // line
    L.selected.add(2); // text: no thickness
    L.selected.add(3); // poly
    expect(L.setSelectedWidth(8)).toBe(3);
    expect(L.items.map((e) => e && entWidth(e))).toEqual([8, 8, undefined, 8]);
    expect(L.canUndo).toBe(true);
    expect(L.undo()).toEqual({ kind: "width", n: 3 });
    expect(L.items.map((e) => e && entWidth(e))).toEqual([1.5, 1.5, undefined, 1.5]);
    expect(L.redo()).toEqual({ kind: "width", n: 3 });
    expect(L.items[1]).toMatchObject({ type: "line", w: 8 });
  });

  it("does nothing, and records nothing, when the thickness is already that value", () => {
    const L = new DrawingLayer([
      { type: "line", x1: 0, y1: 0, x2: 5, y2: 5, color: "#111111", w: 3 },
    ]);
    L.selected.add(0);
    expect(L.setSelectedWidth(3)).toBe(0);
    expect(L.canUndo).toBe(false);
  });

  it("maps every choice to a standard CAD lineweight and back", () => {
    for (const px of THICKNESS) expect(lineweightToWidth(widthToLineweight(px))).toBe(px);
    expect(lineweightToWidth(undefined)).toBe(1);
    expect(lineweightToWidth(-3)).toBe(1); // "default"/"by layer"
  });
});

describe("DXF with thickness and circled numbers", () => {
  const ents: Ent[] = [
    { type: "line", x1: 0, y1: 0, x2: 100, y2: 0, color: "#111111", w: 5 },
    { type: "marker", x: 50, y: 20, r: 8, n: "03", color: "#ff4d4d", w: 2 },
  ];

  it("writes an R2000 file that stores the lineweight of lines and circles", () => {
    const dxf = toDxf(ents).split("\n");
    expect(dxf[dxf.indexOf("$ACADVER") + 2]).toBe("AC1015");
    expect(dxf.filter((l, i) => i % 2 === 1 && dxf[i - 1] === "370")).toEqual([
      String(widthToLineweight(5)),
      String(widthToLineweight(2)),
    ]);
    expect(dxf).toContain("CIRCLE");
    expect(dxf).toContain("03");
  });

  it("reads the thickness back when the file is reopened", () => {
    const back = parseDxf(toDxf(ents));
    expect(back.find((e) => e.type === "line")).toMatchObject({ w: 5 });
    // the circle comes back as a polyline of the same thickness, the number as text
    expect(back.find((e) => e.type === "poly")).toMatchObject({ w: 2 });
    expect(back.find((e) => e.type === "text")).toMatchObject({ text: "03" });
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

describe("copy / paste and trim", () => {
  const L = (x1: number, y1: number, x2: number, y2: number): Ent => ({
    type: "line",
    x1,
    y1,
    x2,
    y2,
    color: "#111",
    w: 3,
  });

  it("pastes copies moved by the offset, selects them, and undoes in one step", () => {
    const d = new DrawingLayer([
      L(0, 0, 10, 0),
      { type: "marker", x: 5, y: 5, r: 4, n: "00", color: "#111" },
    ]);
    d.selected = new Set([0, 1]);
    const clip = d.copySelected();
    expect(d.paste(clip, 20, 30)).toBe(2);
    expect(d.count).toBe(4);
    expect(d.selected.size).toBe(2);
    expect(d.items[2]).toMatchObject({ x1: 20, y1: 30, x2: 30, y2: 30 });
    expect(d.items[3]).toMatchObject({ x: 25, y: 35, n: "00" });
    expect(d.items[0]).toMatchObject({ x1: 0 }); // original untouched
    d.undo();
    expect(d.count).toBe(2);
    d.redo();
    expect(d.count).toBe(4);
  });

  it("trims a line between the two nearest crossings", () => {
    const d = new DrawingLayer([L(0, 0, 100, 0), L(30, -10, 30, 10), L(70, -10, 70, 10)]);
    expect(d.trimAt(50, 0, 3)).toBe(true);
    const lines = d.toEnts().filter((e) => e.type === "line" && e.y1 === 0 && e.y2 === 0);
    expect(lines).toHaveLength(2);
    expect(lines).toMatchObject([
      { x1: 0, x2: 30 },
      { x1: 70, x2: 100 },
    ]);
    d.undo();
    expect(d.toEnts()).toHaveLength(3);
    expect(d.toEnts()[0]).toMatchObject({ x1: 0, x2: 100 });
    d.redo();
    expect(d.toEnts()).toHaveLength(4);
  });

  it("trims up to the end when there is a crossing on one side only", () => {
    const d = new DrawingLayer([L(0, 0, 100, 0), L(30, -10, 30, 10)]);
    expect(d.trimAt(80, 0, 3)).toBe(true);
    const rest = d.toEnts().filter((e) => e.type === "line" && e.y1 === 0 && e.y2 === 0);
    expect(rest).toMatchObject([{ x1: 0, x2: 30 }]);
  });

  it("splits a rectangle side and leaves the other sides", () => {
    const d = new DrawingLayer([
      { type: "rect", x: 0, y: 0, w: 100, h: 50, color: "#111", sw: 3 },
      L(50, -20, 50, 20),
    ]);
    expect(d.trimAt(80, 0, 3)).toBe(true); // top side right of the crossing
    expect(d.toEnts().filter((e) => e.type === "line")).toHaveLength(1 + 3 + 1);
  });

  it("does nothing without a crossing", () => {
    const d = new DrawingLayer([L(0, 0, 100, 0)]);
    expect(d.trimAt(50, 0, 3)).toBe(false);
    expect(d.count).toBe(1);
  });
});
