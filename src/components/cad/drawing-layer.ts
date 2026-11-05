// Pulizia DWG - revisione 2 novembre 2026
import {
  A4_MM,
  DOT_FACTOR,
  EXPORT_DPI,
  PEN_MM_PER_PX,
  entWidth,
  leaderStart,
  markerFontSize,
  withWidth,
  type Ent,
  type Sheet,
} from "./cad-data";

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

const strokeWidth = (e: Ent) => (e.type === "text" ? 0 : (entWidth(e) ?? 1.5));

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

type Seg = [number, number, number, number];

/** The straight pieces an entity is made of (markers and text have none). */
function segmentsOf(e: Ent): Seg[] {
  if (e.type === "line") return [[e.x1, e.y1, e.x2, e.y2]];
  if (e.type === "rect") {
    const r = e.x + e.w,
      b = e.y + e.h;
    return [
      [e.x, e.y, r, e.y],
      [r, e.y, r, b],
      [r, b, e.x, b],
      [e.x, b, e.x, e.y],
    ];
  }
  if (e.type === "poly") {
    const out: Seg[] = [];
    for (let i = 1; i < e.pts.length; i++)
      out.push([e.pts[i - 1]!.x, e.pts[i - 1]!.y, e.pts[i]!.x, e.pts[i]!.y]);
    return out;
  }
  return [];
}

/** Where segment `a` is crossed by segment `b`, as a position 0..1 along `a` (null: no crossing). */
function crossing(a: Seg, b: Seg): number | null {
  const rx = a[2] - a[0],
    ry = a[3] - a[1],
    sx = b[2] - b[0],
    sy = b[3] - b[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null; // parallel
  const qx = b[0] - a[0],
    qy = b[1] - a[1];
  const t = (qx * sy - qy * sx) / den,
    u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
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
    case "marker": {
      const dot = e.r * DOT_FACTOR;
      const tx = e.tx ?? e.x,
        ty = e.ty ?? e.y;
      return [
        Math.min(e.x - e.r, tx - dot),
        Math.min(e.y - e.r, ty - dot),
        Math.max(e.x + e.r, tx + dot),
        Math.max(e.y + e.r, ty + dot),
      ];
    }
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
    case "marker": {
      // the whole disc is clickable, not just the outline; so are the leader line and its dot
      if (Math.hypot(x - e.x, y - e.y) <= e.r + tol) return true;
      const from = leaderStart(e);
      if (!from) return false;
      return (
        distToSegment(x, y, from[0], from[1], e.tx!, e.ty!) <= tol ||
        Math.hypot(x - e.tx!, y - e.ty!) <= e.r * DOT_FACTOR + tol
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

function moveEnt(e: Ent, dx: number, dy: number, keepTarget = false): Ent {
  if (e.type === "line")
    return { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
  if (e.type === "poly") return { ...e, pts: e.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  if (e.type === "marker" && e.tx !== undefined && e.ty !== undefined && !keepTarget)
    return { ...e, x: e.x + dx, y: e.y + dy, tx: e.tx + dx, ty: e.ty + dy };
  return { ...e, x: e.x + dx, y: e.y + dy };
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
  } else if (e.type === "marker") {
    ctx.moveTo(e.x + e.r, e.y);
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    const from = leaderStart(e);
    if (from) {
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(e.tx!, e.ty!);
    }
  }
}

/** Does the segment A-B touch or cross the rectangle (Liang-Barsky clipping)? */
function segHitsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const dx = bx - ax,
    dy = by - ay;
  const p = [-dx, dx, -dy, dy],
    q = [ax - x1, x2 - ax, ay - y1, y2 - ay];
  let t0 = 0,
    t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return false;
    } else {
      const r = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

/** Does the entity's drawn geometry touch the rectangle (inside, or crossing its border)? */
function touchesRect(e: Ent, x1: number, y1: number, x2: number, y2: number): boolean {
  switch (e.type) {
    case "line":
      return segHitsRect(e.x1, e.y1, e.x2, e.y2, x1, y1, x2, y2);
    case "poly": {
      const p = e.pts;
      for (let i = 1; i < p.length; i++)
        if (segHitsRect(p[i - 1]!.x, p[i - 1]!.y, p[i]!.x, p[i]!.y, x1, y1, x2, y2)) return true;
      return false;
    }
    case "rect": {
      // Only the outline counts: a box drawn inside a room must not grab the wall around it.
      const r = e.x + e.w,
        b = e.y + e.h;
      return (
        segHitsRect(e.x, e.y, r, e.y, x1, y1, x2, y2) ||
        segHitsRect(r, e.y, r, b, x1, y1, x2, y2) ||
        segHitsRect(r, b, e.x, b, x1, y1, x2, y2) ||
        segHitsRect(e.x, b, e.x, e.y, x1, y1, x2, y2)
      );
    }
    case "marker": {
      // the circle, or its leader line, or the dot at the end of it
      if (e.x + e.r >= x1 && e.x - e.r <= x2 && e.y + e.r >= y1 && e.y - e.r <= y2) return true;
      const from = leaderStart(e);
      if (!from) return false;
      return (
        segHitsRect(from[0], from[1], e.tx!, e.ty!, x1, y1, x2, y2) ||
        (e.tx! >= x1 && e.tx! <= x2 && e.ty! >= y1 && e.ty! <= y2)
      );
    }
    case "text":
      return true; // the caller already checked its bounding box overlaps the rectangle
  }
}

type WidthChange = { i: number; from: number; to: number };
type Action =
  | { kind: "remove" | "add"; idx: number[] }
  | { kind: "width"; changes: WidthChange[] }
  | { kind: "trim"; removed: number[]; added: number[] }
  | { kind: "move"; idx: number[]; dx: number; dy: number; keepTarget?: boolean }
  | { kind: "edit"; changes: { i: number; from: Ent; to: Ent }[] };

type Bucket = { color: string; w: number; idx: number[] };

export class DrawingLayer {
  /** Entities by index; a removed entity leaves `null` so indexes stay stable. */
  items: (Ent | null)[] = [];
  selected = new Set<number>();
  /** The "Numeri" layer switched off: circled numbers are not drawn, picked or exported. */
  hideMarkers = false;
  count = 0;
  private bb: number[] = []; // x1,y1,x2,y2 per item
  private strokes: Map<string, Bucket> | null = null;
  private texts: number[] = [];
  private labels: number[] = []; // markers, whose number is drawn as text

  /** Removed entities, kept so that a removal can be undone. */
  private graveyard = new Map<number, Ent>();
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];

  constructor(ents: Ent[] = []) {
    for (const e of ents) this.add(e);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  private shown(e: Ent) {
    return !(this.hideMarkers && e.type === "marker");
  }

  /** Switch the circled-numbers layer on or off (not an undo step; the view state). */
  setMarkersVisible(visible: boolean) {
    this.hideMarkers = !visible;
    if (!visible)
      for (const i of [...this.selected])
        if (this.items[i]?.type === "marker") this.selected.delete(i);
    this.strokes = null;
  }

  /** Bounds of the selected entities, or null when nothing is selected. */
  selectionBounds(): Bounds | null {
    let x1 = Infinity,
      y1 = Infinity,
      x2 = -Infinity,
      y2 = -Infinity;
    for (const i of this.selected) {
      if (!this.items[i]) continue;
      const k = i * 4;
      x1 = Math.min(x1, this.bb[k]!);
      y1 = Math.min(y1, this.bb[k + 1]!);
      x2 = Math.max(x2, this.bb[k + 2]!);
      y2 = Math.max(y2, this.bb[k + 3]!);
    }
    return x1 === Infinity ? null : { x1, y1, x2, y2 };
  }

  /** Low-level add (no history); used while loading. */
  add(e: Ent): number {
    const i = this.items.length;
    const b = entBounds(e);
    this.items.push(e);
    this.bb.push(b[0], b[1], b[2], b[3]);
    this.count++;
    this.strokes = null;
    return i;
  }

  /** Add a user-made entity as one undoable step. */
  addUndoable(e: Ent): number {
    const i = this.add(e);
    this.record("add", [i]);
    return i;
  }

  /** Low-level remove (no history): lets the eraser take out entities live during a stroke. */
  remove(i: number): boolean {
    const e = this.items[i];
    if (!e) return false;
    this.graveyard.set(i, e);
    this.items[i] = null;
    this.selected.delete(i);
    this.count--;
    this.strokes = null;
    return true;
  }

  private restore(i: number): boolean {
    const e = this.graveyard.get(i);
    if (!e || this.items[i]) return false;
    this.items[i] = e;
    this.graveyard.delete(i);
    this.count++;
    this.strokes = null;
    return true;
  }

  /** Register already-performed changes as one undoable step. */
  record(kind: "remove" | "add", idx: number[]) {
    if (!idx.length) return;
    this.undoStack.push({ kind, idx });
    this.redoStack = [];
  }

  /** Remove the selection as one undoable step; returns how many were removed. */
  removeSelected(): number {
    const done: number[] = [];
    for (const i of [...this.selected]) if (this.remove(i)) done.push(i);
    this.selected.clear();
    this.record("remove", done);
    return done.length;
  }

  /**
   * Set the line thickness of the selected entities (text has none) as one undoable step;
   * returns how many were changed.
   */
  setSelectedWidth(w: number): number {
    const changes: WidthChange[] = [];
    for (const i of this.selected) {
      const e = this.items[i];
      const from = e ? entWidth(e) : undefined;
      if (e && from !== undefined && from !== w) {
        this.items[i] = withWidth(e, w);
        changes.push({ i, from, to: w });
      }
    }
    if (changes.length) {
      this.strokes = null;
      this.undoStack.push({ kind: "width", changes });
      this.redoStack = [];
    }
    return changes.length;
  }

  /** Replace an entity in place (keeps its index and refreshes its bounds). */
  private setItem(i: number, e: Ent) {
    this.items[i] = e;
    const b = entBounds(e);
    this.bb[i * 4] = b[0];
    this.bb[i * 4 + 1] = b[1];
    this.bb[i * 4 + 2] = b[2];
    this.bb[i * 4 + 3] = b[3];
    this.strokes = null;
  }

  /** Move entities with no history (live while dragging); call `recordMove` when done. */
  translate(idx: Iterable<number>, dx: number, dy: number, keepTarget = false) {
    for (const i of idx) {
      const e = this.items[i];
      if (e) this.setItem(i, moveEnt(e, dx, dy, keepTarget));
    }
  }

  /** Topmost number whose leader dot is within `tol` of (x, y), or -1. */
  hitTarget(x: number, y: number, tol: number): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i];
      if (!e || e.type !== "marker" || !this.shown(e) || !leaderStart(e)) continue;
      if (Math.hypot(x - e.tx!, y - e.ty!) <= e.r * DOT_FACTOR + tol) return i;
    }
    return -1;
  }

  /** Move the point a number refers to (no history while dragging; see `recordEdit`). */
  setTarget(i: number, tx: number, ty: number) {
    const e = this.items[i];
    if (e && e.type === "marker") this.setItem(i, { ...e, tx, ty });
  }

  /** Register an entity change already made (`from` is how it was) as one undoable step. */
  recordEdit(i: number, from: Ent) {
    const to = this.items[i];
    if (!to || JSON.stringify(to) === JSON.stringify(from)) return;
    this.undoStack.push({ kind: "edit", changes: [{ i, from, to }] });
    this.redoStack = [];
  }

  /** Register a finished drag as one undoable step. */
  recordMove(idx: number[], dx: number, dy: number, keepTarget = false) {
    if (!idx.length || (!dx && !dy)) return;
    this.undoStack.push({ kind: "move", idx, dx, dy, keepTarget });
    this.redoStack = [];
  }

  /** Change the number written in a circled number (undoable). */
  setMarkerNumber(i: number, n: string): boolean {
    const e = this.items[i];
    if (!e || e.type !== "marker" || e.n === n) return false;
    const to: Ent = { ...e, n };
    this.setItem(i, to);
    this.undoStack.push({ kind: "edit", changes: [{ i, from: e, to }] });
    this.redoStack = [];
    return true;
  }

  /** Copies of the selected entities (for copy / paste). */
  copySelected(): Ent[] {
    const out: Ent[] = [];
    for (const i of [...this.selected].sort((a, b) => a - b)) {
      const e = this.items[i];
      if (e) out.push(structuredClone(e));
    }
    return out;
  }

  /** Add copies of `ents` moved by (dx, dy) as one undoable step and select them. */
  paste(ents: Ent[], dx: number, dy: number): number {
    const idx: number[] = [];
    for (const e of ents) idx.push(this.add(moveEnt(structuredClone(e), dx, dy)));
    this.selected = new Set(idx);
    this.record("add", idx);
    return idx.length;
  }

  /**
   * Trim (like AutoCAD's TRIM): treat the whole line / polyline / rectangle under (x, y) as one
   * continuous path, find every crossing along it, and cut away the stretch between the two
   * crossings nearest the pointer (or up to an open end). Works on spirals made of hundreds of
   * tiny pieces. Returns false when nothing was cut.
   */
  trimAt(x: number, y: number, tol: number): boolean {
    const hit = this.hitAt(x, y, tol);
    const e = hit >= 0 ? this.items[hit] : null;
    if (!e) return false;
    const segs = segmentsOf(e);
    if (!segs.length) return false;
    const pts = [{ x: segs[0]![0], y: segs[0]![1] }, ...segs.map((s) => ({ x: s[2], y: s[3] }))];
    // where on the path the pointer is (s = segment index + position 0..1)
    let si = 0,
      tc = 0,
      best = Infinity;
    segs.forEach((s, k) => {
      const dx = s[2] - s[0],
        dy = s[3] - s[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / len2)) : 0;
      const d = Math.hypot(x - (s[0] + dx * t), y - (s[1] + dy * t));
      if (d < best) {
        best = d;
        si = k;
        tc = t;
      }
    });
    const click = si + tc;
    const n = segs.length;
    const eps = 1e-6;
    const cuts: number[] = [];
    const closed = n > 2 && Math.hypot(pts[0]!.x - pts[n]!.x, pts[0]!.y - pts[n]!.y) < eps;
    for (let j = 0; j < this.items.length; j++) {
      const o = this.items[j];
      if (!o) continue;
      const others = j === hit ? segs : segmentsOf(o);
      if (!others.length) continue;
      const kb = j * 4;
      const oMinX = this.bb[kb]!,
        oMinY = this.bb[kb + 1]!,
        oMaxX = this.bb[kb + 2]!,
        oMaxY = this.bb[kb + 3]!;
      for (let k = 0; k < n; k++) {
        const s = segs[k]!;
        if (
          j !== hit &&
          (Math.max(s[0], s[2]) < oMinX ||
            Math.min(s[0], s[2]) > oMaxX ||
            Math.max(s[1], s[3]) < oMinY ||
            Math.min(s[1], s[3]) > oMaxY)
        )
          continue;
        for (let m = 0; m < others.length; m++) {
          if (j === hit) {
            // skip itself and the neighbours sharing a vertex
            if (Math.abs(k - m) <= 1) continue;
            if (closed && Math.abs(k - m) === n - 1) continue;
          }
          const t = crossing(s, others[m]!);
          if (t !== null) cuts.push(k + t);
        }
      }
    }
    // the crossings just before and just after the pointer
    let lo = -Infinity,
      hi = Infinity;
    for (const c of cuts) {
      if (c < click - eps && c > lo) lo = c;
      if (c > click + eps && c < hi) hi = c;
    }
    if (closed) {
      // a closed outline has no ends: wrap around, and it needs two different crossings
      const uniq = new Set(cuts.map((c) => (((c % n) + n) % n).toFixed(6)));
      if (uniq.size < 2) return false;
      if (lo === -Infinity) lo = Math.max(...cuts) - n;
      if (hi === Infinity) hi = Math.min(...cuts) + n;
    } else {
      if (lo === -Infinity && hi === Infinity) return false;
      if (lo === -Infinity) lo = 0;
      if (hi === Infinity) hi = n;
    }
    // points of the path between positions a < b (positions may run past n on closed paths)
    const vtx = (i: number) => pts[((i % n) + n) % n]!;
    const pointAt = (s: number) => {
      const w = s < 0 ? s + n : s >= n ? s - n : s;
      const k = Math.min(Math.floor(w), n - 1);
      const f = w - k;
      const g = segs[k]!;
      return { x: g[0] + (g[2] - g[0]) * f, y: g[1] + (g[3] - g[1]) * f };
    };
    const span = (a: number, b: number) => {
      const out = [pointAt(a)];
      for (let i = Math.floor(a) + 1; i < b - eps; i++) out.push(closed ? vtx(i) : pts[i]!);
      out.push(b >= n - eps && !closed ? pts[n]! : pointAt(b));
      return out;
    };
    const w = entWidth(e) ?? 1.5;
    const make = (p: { x: number; y: number }[]): Ent | null => {
      const q = p.filter(
        (v, i) => i === 0 || Math.hypot(v.x - p[i - 1]!.x, v.y - p[i - 1]!.y) > eps,
      );
      if (q.length < 2) return null;
      if (q.length === 2)
        return {
          type: "line",
          x1: q[0]!.x,
          y1: q[0]!.y,
          x2: q[1]!.x,
          y2: q[1]!.y,
          color: e.color,
          w,
        };
      return { type: "poly", pts: q, color: e.color, w };
    };
    const keep: Ent[] = [];
    const pieces = closed
      ? [span(hi, lo + n)]
      : [lo > eps ? span(0, lo) : [], hi < n - eps ? span(hi, n) : []];
    for (const p of pieces) {
      const ent = make(p);
      if (ent) keep.push(ent);
    }
    this.remove(hit);
    const added = keep.map((k) => this.add(k));
    this.undoStack.push({ kind: "trim", removed: [hit], added });
    this.redoStack = [];
    return true;
  }

  /** Explode: split the selected polylines / rectangles into single lines (undoable). */
  explodeSelected(): number {
    const removed: number[] = [];
    const added: number[] = [];
    for (const i of [...this.selected]) {
      const e = this.items[i];
      if (!e || (e.type !== "poly" && e.type !== "rect")) continue;
      const segs = segmentsOf(e);
      const w = entWidth(e) ?? 1.5;
      this.remove(i);
      removed.push(i);
      for (const s of segs)
        added.push(
          this.add({ type: "line", x1: s[0], y1: s[1], x2: s[2], y2: s[3], color: e.color, w }),
        );
    }
    if (!removed.length) return 0;
    this.undoStack.push({ kind: "trim", removed, added });
    this.redoStack = [];
    this.selected = new Set(added);
    return removed.length;
  }

  private apply(a: Action, undo: boolean): number {
    if (a.kind === "move") {
      const k = undo ? -1 : 1;
      this.translate(a.idx, a.dx * k, a.dy * k, a.keepTarget);
      return a.idx.length;
    }
    if (a.kind === "edit") {
      for (const c of a.changes) this.setItem(c.i, undo ? c.from : c.to);
      return a.changes.length;
    }
    if (a.kind === "trim") {
      const [off, on] = undo ? [a.added, a.removed] : [a.removed, a.added];
      for (const i of off) this.remove(i);
      for (const i of on) this.restore(i);
      return on.length;
    }
    if (a.kind === "width") {
      let n = 0;
      for (const c of a.changes) {
        const e = this.items[c.i];
        if (!e) continue;
        this.items[c.i] = withWidth(e, undo ? c.from : c.to);
        n++;
      }
      this.strokes = null;
      return n;
    }
    // undoing a removal restores; undoing an addition removes; redo is the opposite
    const restoring = (a.kind === "remove") === undo;
    let n = 0;
    for (const i of a.idx) if (restoring ? this.restore(i) : this.remove(i)) n++;
    return n;
  }

  undo(): { kind: Action["kind"]; n: number } | null {
    const a = this.undoStack.pop();
    if (!a) return null;
    this.redoStack.push(a);
    this.selected.clear();
    return { kind: a.kind, n: this.apply(a, true) };
  }

  redo(): { kind: Action["kind"]; n: number } | null {
    const a = this.redoStack.pop();
    if (!a) return null;
    this.undoStack.push(a);
    this.selected.clear();
    return { kind: a.kind, n: this.apply(a, false) };
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
      const e = this.items[i];
      if (!e || !this.shown(e)) continue;
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
      if (!e || !this.shown(e)) continue;
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

  /** Window selection: only entities lying entirely inside the rectangle. */
  insideRect(a: { x: number; y: number }, b: { x: number; y: number }): number[] {
    const x1 = Math.min(a.x, b.x),
      x2 = Math.max(a.x, b.x),
      y1 = Math.min(a.y, b.y),
      y2 = Math.max(a.y, b.y);
    const out: number[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const e = this.items[i];
      if (!e || !this.shown(e)) continue;
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

  /** Crossing selection: entities inside the rectangle or touching its border. */
  touchRect(a: { x: number; y: number }, b: { x: number; y: number }): number[] {
    const x1 = Math.min(a.x, b.x),
      x2 = Math.max(a.x, b.x),
      y1 = Math.min(a.y, b.y),
      y2 = Math.max(a.y, b.y);
    const out: number[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const e = this.items[i];
      if (!e || !this.shown(e)) continue;
      const k = i * 4;
      // cheap bounding-box test first, exact geometry only for what survives
      if (this.bb[k + 2]! < x1 || this.bb[k]! > x2 || this.bb[k + 3]! < y1 || this.bb[k + 1]! > y2)
        continue;
      if (touchesRect(e, x1, y1, x2, y2)) out.push(i);
    }
    return out;
  }

  private build() {
    if (this.strokes) return;
    this.strokes = new Map();
    this.texts = [];
    this.labels = [];
    for (let i = 0; i < this.items.length; i++) {
      const e = this.items[i];
      if (!e || !this.shown(e)) continue;
      if (e.type === "text") {
        this.texts.push(i);
        continue;
      }
      if (e.type === "marker") this.labels.push(i); // circle goes below, number is drawn later
      const w = strokeWidth(e);
      const key = `${e.color}|${w}`;
      let b = this.strokes.get(key);
      if (!b) this.strokes.set(key, (b = { color: e.color, w, idx: [] }));
      b.idx.push(i);
    }
  }

  /** Draw the whole drawing; `vpt` is the canvas viewport transform, w/h the canvas size. */
  draw(
    ctx: CanvasRenderingContext2D,
    vpt: ArrayLike<number>,
    w: number,
    h: number,
    strokeScale = 1,
  ) {
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
      ctx.lineWidth = (b.w * strokeScale) / z; // constant width on screen
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
    // the number inside each circled-number marker
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const i of this.labels) {
      const e = this.items[i];
      if (!e || e.type !== "marker") continue;
      const k = i * 4;
      if (bb[k + 2]! < vx1 || bb[k]! > vx2 || bb[k + 3]! < vy1 || bb[k + 1]! > vy2) continue;
      ctx.fillStyle = e.color;
      if (leaderStart(e)) {
        ctx.beginPath();
        ctx.arc(e.tx!, e.ty!, Math.max(e.r * DOT_FACTOR, 2.2 / z), 0, Math.PI * 2);
        ctx.fill();
      }
      const size = markerFontSize(e.r, e.n);
      if (size * z < 3) continue;
      ctx.font = `bold ${size}px "JetBrains Mono", monospace`;
      ctx.fillText(e.n, e.x, e.y + size * 0.06);
    }
    ctx.textAlign = "start";
    ctx.restore();
  }

  /**
   * Render the whole drawing to a PNG with a transparent background (no grid, no selection).
   * The longest side is `maxSide` pixels; returns null when the drawing is empty.
   */
  toPngBlob(maxSide = 3000, pad = 24): Promise<Blob | null> {
    const b = this.bounds();
    if (!b) return Promise.resolve(null);
    const bw = b.x2 - b.x1 || 1,
      bh = b.y2 - b.y1 || 1;
    const z = (maxSide - pad * 2) / Math.max(bw, bh);
    const W = Math.max(1, Math.ceil(bw * z + pad * 2)),
      H = Math.max(1, Math.ceil(bh * z + pad * 2));
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    // thicker strokes on a big image so lines stay readable when the picture is scaled down
    const strokeScale = Math.max(1, Math.min(3, z * 0.6));
    this.draw(ctx, [z, 0, 0, z, pad - b.x1 * z, pad - b.y1 * z], W, H, strokeScale);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  }

  /**
   * Render only what lies inside the A4 frame, at 300 dpi, transparent, without the frame itself.
   * Pen widths follow the paper (0.1 mm per thickness step) so lines survive being scaled down.
   */
  toSheetPngBlob(sheet: Sheet, only?: Iterable<number>): Promise<Blob | null> {
    if (only) {
      // export just the chosen entities, plus the circled numbers (their own layer, and they
      // are placed after the frame was fitted); drawn from a layer of their own
      const keep = new Set(only);
      this.items.forEach((e, i) => {
        if (e && e.type === "marker") keep.add(i);
      });
      const sub = new DrawingLayer(
        [...keep]
          .sort((x, y) => x - y)
          .map((i) => this.items[i])
          .filter((e): e is Ent => !!e),
      );
      sub.hideMarkers = this.hideMarkers;
      return sub.toSheetPngBlob(sheet);
    }
    const mmW = sheet.land ? A4_MM.long : A4_MM.short,
      mmH = sheet.land ? A4_MM.short : A4_MM.long;
    const W = Math.round((mmW / 25.4) * EXPORT_DPI),
      H = Math.round((mmH / 25.4) * EXPORT_DPI);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    const z = W / sheet.w;
    const strokeScale = (PEN_MM_PER_PX / 25.4) * EXPORT_DPI;
    this.draw(ctx, [z, 0, 0, z, -sheet.x * z, -sheet.y * z], W, H, strokeScale);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  }

  /** Give every circled number the same radius (undoable unless `record` is false); returns how many changed. */
  setMarkersRadius(r: number, record = true): number {
    const changes: { i: number; from: Ent; to: Ent }[] = [];
    this.items.forEach((e, i) => {
      if (e && e.type === "marker" && Math.abs(e.r - r) > 1e-9) {
        const to: Ent = { ...e, r };
        this.setItem(i, to);
        changes.push({ i, from: e, to });
      }
    });
    if (changes.length && record) {
      this.undoStack.push({ kind: "edit", changes });
      this.redoStack = [];
    }
    return changes.length;
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
      if (!e || !this.shown(e)) continue;
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
