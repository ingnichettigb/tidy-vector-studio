import type { Ent } from "./cad-data";

/**
 * The drawing as plain data plus a batch renderer.
 *
 * One canvas object per entity (what Fabric does) costs ~8 KB and a full redraw of every
 * object on each frame: 150k entities meant 1.2 GB and >1 s per zoom step. Here entities are
 * small records, strokes are drawn in one path per colour/width, and picking is plain geometry.
 */

export type Bounds = { x1: number; y1: number; x2: number; y2: number };

const TEXT_ADVANCE = 0.6; // monospace glyph width / font size
const TEXT_HEIGHT = 1.2; // text box height / font size
const SELECT_COLOR = "#3b9cff";

type TextEnt = Extract<Ent, { type: "text" }>;

const strokeWidth = (e: Ent) =>
  e.type === "rect" ? (e.sw ?? 1.5) : e.type === "text" ? 0 : (e.w ?? 1.5);

function textBox(e: TextEnt) {
  return { w: e.text.length * e.size * TEXT_ADVANCE, h: e.size * TEXT_HEIGHT };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function entBounds(e: Ent): [number, number, number, number] {
  switch (e.type) {
    case "line":
      return [
        Math.min(e.x1, e.x2),
        Math.min(e.y1, e.y2),
        Math.max(e.x1, e.x2),
        Math.max(e.y1, e.y2),
      ];
    case "poly": {
      let x1 = Infinity,
        y1 = Infinity,
        x2 = -Infinity,
        y2 = -Infinity;
      for (const p of e.pts) {
        if (p.x < x1) x1 = p.x;
        if (p.x > x2) x2 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.y > y2) y2 = p.y;
      }
      return [x1, y1, x2, y2];
    }
    case "rect":
      return [e.x, e.y, e.x + e.w, e.y + e.h];
    case "text": {
      const { w, h } = textBox(e);
      const a = ((e.angle ?? 0) * Math.PI) / 180,
        cos = Math.cos(a),
        sin = Math.sin(a);
      const xs = [0, w, w, 0].map((x, i) => e.x + x * cos - [0, 0, h, h][i]! * sin);
      const ys = [0, w, w, 0].map((x, i) => e.y + x * sin + [0, 0, h, h][i]! * cos);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  }
}

function hitsEnt(e: Ent, x: number, y: number, tol: number): boolean {
  switch (e.type) {
    case "line":
      return distToSegment(x, y, e.x1, e.y1, e.x2, e.y2) <= tol;
    case "poly": {
      const p = e.pts;
      for (let i = 1; i < p.length; i++)
        if (distToSegment(x, y, p[i - 1]!.x, p[i - 1]!.y, p[i]!.x, p[i]!.y) <= tol) return true;
      return false;
    }
    case "rect": {
      const r = e.x + e.w,
        b = e.y + e.h;
      return (
        distToSegment(x, y, e.x, e.y, r, e.y) <= tol ||
        distToSegment(x, y, r, e.y, r, b) <= tol ||
        distToSegment(x, y, r, b, e.x, b) <= tol ||
        distToSegment(x, y, e.x, b, e.x, e.y) <= tol
      );
    }
    case "text": {
      const a = ((e.angle ?? 0) * Math.PI) / 180;
      const dx = x - e.x,
        dy = y - e.y;
      const lx = dx * Math.cos(a) + dy * Math.sin(a),
        ly = -dx * Math.sin(a) + dy * Math.cos(a);
      const { w, h } = textBox(e);
      return lx >= -tol && lx <= w + tol && ly >= -tol && ly <= h + tol;
    }
  }
}

function addPath(ctx: CanvasRenderingContext2D, e: Ent) {
  if (e.type === "line") {
    ctx.moveTo(e.x1, e.y1);
    ctx.lineTo(e.x2, e.y2);
  } else if (e.type === "poly") {
    const p = e.pts;
    ctx.moveTo(p[0]!.x, p[0]!.y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i]!.x, p[i]!.y);
  } else if (e.type === "rect") {
    ctx.rect(e.x, e.y, e.w, e.h);
  }
}

type Bucket = { color: string; w: number; idx: number[] };

export class DrawingLayer {
  /** Entities by index; a removed entity leaves `null` so indexes stay stable. */
  items: (Ent | null)[] = [];
  selected = new Set<number>();
  count = 0;
  private bb: number[] = []; // x1,y1,x2,y2 per item
  private strokes: Map<string, Bucket> | null = null;
  private texts: number[] = [];

  constructor(ents: Ent[] = []) {
    for (const e of ents) this.add(e);
  }

  add(e: Ent): number {
    const i = this.items.length;
    const b = entBounds(e);
    this.items.push(e);
    this.bb.push(b[0], b[1], b[2], b[3]);
    this.count++;
    this.strokes = null;
    return i;
  }

  remove(i: number): boolean {
    if (!this.items[i]) return false;
    this.items[i] = null;
    this.selected.delete(i);
    this.count--;
    this.strokes = null;
    return true;
  }

  removeSelected(): number {
    let n = 0;
    for (const i of [...this.selected]) if (this.remove(i)) n++;
    this.selected.clear();
    return n;
  }

  /** Alive entities, in drawing order (used for export). */
  toEnts(): Ent[] {
    return this.items.filter((e): e is Ent => e !== null);
  }

  bounds(): Bounds | null {
    let x1 = Infinity,
      y1 = Infinity,
      x2 = -Infinity,
      y2 = -Infinity;
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i]) continue;
      const k = i * 4;
      if (this.bb[k]! < x1) x1 = this.bb[k]!;
      if (this.bb[k + 1]! < y1) y1 = this.bb[k + 1]!;
      if (this.bb[k + 2]! > x2) x2 = this.bb[k + 2]!;
      if (this.bb[k + 3]! > y2) y2 = this.bb[k + 3]!;
    }
    return x1 === Infinity ? null : { x1, y1, x2, y2 };
  }

  /** Topmost entity within `tol` scene units of (x, y), or -1. */
  hitAt(x: number, y: number, tol: number): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i];
      if (!e) continue;
      const k = i * 4;
      if (
        x < this.bb[k]! - tol ||
        x > this.bb[k + 2]! + tol ||
        y < this.bb[k + 1]! - tol ||
        y > this.bb[k + 3]! + tol
      )
        continue;
      if (hitsEnt(e, x, y, tol)) return i;
    }
    return -1;
  }

  /** Window selection: entities lying entirely inside the rectangle. */
  insideRect(a: { x: number; y: number }, b: { x: number; y: number }): number[] {
    const x1 = Math.min(a.x, b.x),
      x2 = Math.max(a.x, b.x),
      y1 = Math.min(a.y, b.y),
      y2 = Math.max(a.y, b.y);
    const out: number[] = [];
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i]) continue;
      const k = i * 4;
      if (
        this.bb[k]! >= x1 &&
        this.bb[k + 2]! <= x2 &&
        this.bb[k + 1]! >= y1 &&
        this.bb[k + 3]! <= y2
      )
        out.push(i);
    }
    return out;
  }

  private build() {
    if (this.strokes) return;
    this.strokes = new Map();
    this.texts = [];
    for (let i = 0; i < this.items.length; i++) {
      const e = this.items[i];
      if (!e) continue;
      if (e.type === "text") {
        this.texts.push(i);
        continue;
      }
      const w = strokeWidth(e);
      const key = `${e.color}|${w}`;
      let b = this.strokes.get(key);
      if (!b) this.strokes.set(key, (b = { color: e.color, w, idx: [] }));
      b.idx.push(i);
    }
  }

  /** Draw the whole drawing; `vpt` is the canvas viewport transform, w/h the canvas size. */
  draw(ctx: CanvasRenderingContext2D, vpt: ArrayLike<number>, w: number, h: number) {
    this.build();
    const z = vpt[0]!;
    const vx1 = -vpt[4]! / z,
      vy1 = -vpt[5]! / z,
      vx2 = (w - vpt[4]!) / z,
      vy2 = (h - vpt[5]!) / z;
    const tiny = 0.4 / z; // skip what would be a sub-pixel speck
    const bb = this.bb;
    ctx.save();
    ctx.transform(vpt[0]!, vpt[1]!, vpt[2]!, vpt[3]!, vpt[4]!, vpt[5]!);
    ctx.lineJoin = "round";
    for (const b of this.strokes!.values()) {
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.w / z; // constant width on screen
      ctx.beginPath();
      for (const i of b.idx) {
        const e = this.items[i];
        if (!e) continue;
        const k = i * 4;
        if (bb[k + 2]! < vx1 || bb[k]! > vx2 || bb[k + 3]! < vy1 || bb[k + 1]! > vy2) continue;
        if (bb[k + 2]! - bb[k]! < tiny && bb[k + 3]! - bb[k + 1]! < tiny) continue;
        addPath(ctx, e);
      }
      ctx.stroke();
    }
    // Text too small to read is drawn as a thin colored stroke along its baseline, the way CAD
    // programs do, so a zoomed-out drawing does not look empty (and costs almost nothing).
    ctx.lineWidth = 1 / z;
    ctx.globalAlpha = 0.55;
    let strokeColor = "";
    ctx.beginPath();
    for (const i of this.texts) {
      const e = this.items[i] as TextEnt | null;
      if (!e || e.size * z >= 3) continue;
      const k = i * 4;
      if (bb[k + 2]! < vx1 || bb[k]! > vx2 || bb[k + 3]! < vy1 || bb[k + 1]! > vy2) continue;
      if (e.color !== strokeColor) {
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = strokeColor = e.color;
      }
      const a = ((e.angle ?? 0) * Math.PI) / 180,
        cos = Math.cos(a),
        sin = Math.sin(a);
      const { w: tw, h: th } = textBox(e);
      const sx = e.x - (th / 2) * sin,
        sy = e.y + (th / 2) * cos;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + tw * cos, sy + tw * sin);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.textBaseline = "top";
    let font = "",
      fill = "";
    for (const i of this.texts) {
      const e = this.items[i] as TextEnt | null;
      if (!e || e.size * z < 3) continue; // small ones were drawn above
      const k = i * 4;
      if (bb[k + 2]! < vx1 || bb[k]! > vx2 || bb[k + 3]! < vy1 || bb[k + 1]! > vy2) continue;
      const f = `${e.size}px "JetBrains Mono", monospace`;
      if (f !== font) ctx.font = font = f;
      if (e.color !== fill) ctx.fillStyle = fill = e.color;
      if (e.angle) {
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate((e.angle * Math.PI) / 180);
        ctx.fillText(e.text, 0, 0);
        ctx.restore();
      } else ctx.fillText(e.text, e.x, e.y);
    }
    ctx.restore();
  }

  /** Highlight the selected entities (drawn above everything else). */
  drawSelection(ctx: CanvasRenderingContext2D, vpt: ArrayLike<number>) {
    if (!this.selected.size) return;
    const z = vpt[0]!;
    ctx.save();
    ctx.transform(vpt[0]!, vpt[1]!, vpt[2]!, vpt[3]!, vpt[4]!, vpt[5]!);
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineJoin = "round";
    for (const i of this.selected) {
      const e = this.items[i];
      if (!e) continue;
      ctx.beginPath();
      if (e.type === "text") {
        const { w, h } = textBox(e);
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.rotate(((e.angle ?? 0) * Math.PI) / 180);
        ctx.lineWidth = 1.5 / z;
        ctx.strokeRect(-2 / z, -2 / z, w + 4 / z, h + 4 / z);
        ctx.restore();
        continue;
      }
      ctx.lineWidth = (strokeWidth(e) + 3) / z;
      addPath(ctx, e);
      ctx.stroke();
    }
    ctx.restore();
  }
}
