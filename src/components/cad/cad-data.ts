// Pulizia DWG - revisione 2 novembre 2026
export type Tool = "select" | "pan" | "line" | "rect" | "erase" | "marker" | "trim" | "move";

// Drawing ink colors (CAD entity colors, also mapped to DXF ACI indexes)
export const PALETTE = [
  { label: "Nero", value: "#111111", swatch: "#111111", aci: 7 },
  { label: "Rosso", value: "#ff4d4d", swatch: "#ff4d4d", aci: 1 },
  { label: "Blu", value: "#4da3ff", swatch: "#4da3ff", aci: 5 },
  { label: "Verde", value: "#3ddc84", swatch: "#3ddc84", aci: 3 },
  { label: "Giallo", value: "#ffd23f", swatch: "#ffd23f", aci: 2 },
];

export type Ent =
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; color: string; w?: number }
  | { type: "poly"; pts: { x: number; y: number }[]; color: string; w?: number }
  | {
      type: "marker";
      x: number;
      y: number;
      r: number;
      n: string;
      color: string;
      w?: number;
      /** point the number refers to: a leader line joins it to the circle */
      tx?: number;
      ty?: number;
    }
  | { type: "rect"; x: number; y: number; w: number; h: number; color: string; sw?: number }
  | {
      type: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
      angle?: number;
    };

/** Line thickness choices, in screen pixels. */
export const THICKNESS = [1, 2, 3, 5, 8, 12];
export const DEFAULT_THICKNESS = 3;

// AutoCAD's standard lineweights, in hundredths of a millimetre (DXF group code 370)
const LINEWEIGHTS = [
  5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211,
];
const LW_PER_PX = 18; // 1 px of thickness = 0.18 mm on paper

/** Thickness in screen px -> the nearest standard CAD lineweight. */
export function widthToLineweight(px: number): number {
  const target = px * LW_PER_PX;
  return LINEWEIGHTS.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

/** CAD lineweight (negative = "by layer"/"default") -> thickness in screen px. */
export function lineweightToWidth(lw: number | undefined): number {
  return lw && lw > 0 ? Math.min(12, Math.max(1, Math.round(lw / LW_PER_PX))) : 1;
}

/** Thickness of an entity in px, or undefined for entities that have none (text). */
export function entWidth(e: Ent): number | undefined {
  return e.type === "text" ? undefined : e.type === "rect" ? (e.sw ?? 1.5) : (e.w ?? 1.5);
}

export function withWidth(e: Ent, w: number): Ent {
  if (e.type === "text") return e;
  return e.type === "rect" ? { ...e, sw: w } : { ...e, w };
}

/** A4 sheet: the export frame keeps these proportions; sizes are real millimetres on paper. */
export const A4_MM = { short: 210, long: 297 };
export type Sheet = { x: number; y: number; w: number; h: number; land: boolean };
/** Pen width on paper: one thickness step (screen px) is 0.1 mm. */
export const PEN_MM_PER_PX = 0.1;
export const EXPORT_DPI = 300;
/** Radius in mm on paper of the circled numbers S / M / L (circle 5 / 7 / 9 mm). */
export const MARKER_MM = { S: 2.5, M: 3.5, L: 4.5 } as const;

export const sheetRatio = (land: boolean) =>
  land ? A4_MM.long / A4_MM.short : A4_MM.short / A4_MM.long;

/** A4 frame (same orientation rules as the user picks) centred on `b`, with a small margin. */
export function fitSheet(
  b: { x1: number; y1: number; x2: number; y2: number },
  land: boolean,
  margin = 0.06,
): Sheet {
  const r = sheetRatio(land);
  const bw = Math.max(b.x2 - b.x1, 1e-6),
    bh = Math.max(b.y2 - b.y1, 1e-6);
  const w = Math.max(bw, bh * r) * (1 + margin * 2);
  const h = w / r;
  return { x: (b.x1 + b.x2) / 2 - w / 2, y: (b.y1 + b.y2) / 2 - h / 2, w, h, land };
}

/** Scene units per millimetre of paper for a frame. */
export const sheetUnitsPerMm = (s: Sheet) => s.w / (s.land ? A4_MM.long : A4_MM.short);

/** Radius of the dot at the end of a leader line, relative to the number's circle. */
export const DOT_FACTOR = 0.18;

/** Where a leader line leaves the circle (on its edge, toward the target); null without one. */
export function leaderStart(e: {
  x: number;
  y: number;
  r: number;
  tx?: number;
  ty?: number;
}): [number, number] | null {
  if (e.tx === undefined || e.ty === undefined) return null;
  const d = Math.hypot(e.tx - e.x, e.ty - e.y);
  if (d <= e.r) return null; // target inside the circle: nothing to join
  return [e.x + ((e.tx - e.x) / d) * e.r, e.y + ((e.ty - e.y) / d) * e.r];
}

/** Font size of the number inside a circled-number marker (shrinks for long numbers). */
export function markerFontSize(r: number, n: string): number {
  return Math.min(r, (1.7 * r) / (0.6 * Math.max(2, n.length)));
}

const W = "#111111",
  DIM = "#4da3ff",
  TXT = "#c2410c",
  DOOR = "#3ddc84";

function dim(x1: number, y1: number, x2: number, y2: number, label: string, off: number): Ent[] {
  const horiz = y1 === y2;
  if (horiz) {
    const y = y1 + off;
    return [
      { type: "line", x1, y1: y, x2, y2: y, color: DIM, w: 1 },
      { type: "line", x1, y1: y - 6, x2: x1, y2: y + 6, color: DIM, w: 1 },
      { type: "line", x1: x2, y1: y - 6, x2, y2: y + 6, color: DIM, w: 1 },
      {
        type: "text",
        x: (x1 + x2) / 2 - label.length * 4,
        y: y - 18,
        text: label,
        size: 13,
        color: DIM,
      },
    ];
  }
  const x = x1 + off;
  return [
    { type: "line", x1: x, y1, x2: x, y2, color: DIM, w: 1 },
    { type: "line", x1: x - 6, y1, x2: x + 6, y2: y1, color: DIM, w: 1 },
    { type: "line", x1: x - 6, y1: y2, x2: x + 6, y2, color: DIM, w: 1 },
    {
      type: "text",
      x: x - 6,
      y: (y1 + y2) / 2 + label.length * 4,
      text: label,
      size: 13,
      color: DIM,
      angle: -90,
    },
  ];
}

export function buildMockDrawing(variant: number): Ent[] {
  const e: Ent[] = [];
  // outer walls (double line)
  e.push({ type: "rect", x: 0, y: 0, w: 800, h: 500, color: W, sw: 2.5 });
  e.push({ type: "rect", x: 15, y: 15, w: 770, h: 470, color: W, sw: 1.5 });
  // internal walls
  e.push({ type: "line", x1: 400, y1: 15, x2: 400, y2: 300, color: W, w: 2 });
  e.push({ type: "line", x1: 400, y1: 360, x2: 400, y2: 485, color: W, w: 2 });
  e.push({ type: "line", x1: 15, y1: 280, x2: 250, y2: 280, color: W, w: 2 });
  e.push({ type: "line", x1: 310, y1: 280, x2: 400, y2: 280, color: W, w: 2 });
  if (variant === 1) e.push({ type: "line", x1: 600, y1: 15, x2: 600, y2: 485, color: W, w: 2 });
  // doors
  e.push({ type: "line", x1: 250, y1: 280, x2: 250, y2: 340, color: DOOR, w: 1 });
  e.push({ type: "line", x1: 400, y1: 300, x2: 450, y2: 330, color: DOOR, w: 1 });
  // windows
  e.push({ type: "rect", x: 120, y: -4, w: 120, h: 23, color: DIM, sw: 1 });
  e.push({ type: "rect", x: 540, y: 481, w: 140, h: 23, color: DIM, sw: 1 });
  // furniture
  e.push({ type: "rect", x: 520, y: 80, w: 160, h: 200, color: W, sw: 1 });
  e.push({ type: "rect", x: 60, y: 340, w: 180, h: 90, color: W, sw: 1 });
  // texts
  const rooms =
    variant === 1
      ? [
          ["UFFICIO 1", 140, 130],
          ["SALA RIUNIONI", 440, 200],
          ["ARCHIVIO", 640, 250],
          ["RECEPTION", 100, 390],
        ]
      : [
          ["SOGGIORNO", 130, 130],
          ["CAMERA", 560, 300],
          ["CUCINA", 110, 300],
          ["BAGNO", 290, 400],
        ];
  rooms.forEach(([t, x, y]) => {
    e.push({
      type: "text",
      x: x as number,
      y: y as number,
      text: t as string,
      size: 20,
      color: TXT,
    });
    e.push({
      type: "text",
      x: x as number,
      y: (y as number) + 26,
      text: "h = 2.70 m",
      size: 12,
      color: TXT,
    });
  });
  e.push({
    type: "text",
    x: 0,
    y: 580,
    text: variant === 1 ? "PIANTA PIANO TERRA - FILE IMPORTATO" : "PIANTA ABITAZIONE - SCALA 1:100",
    size: 18,
    color: W,
  });
  // dimensions
  e.push(...dim(0, 500, 800, 500, "8.00", 40));
  e.push(...dim(0, 0, 400, 0, "4.00", -40));
  e.push(...dim(800, 0, 800, 500, "5.00", 40));
  return e;
}

/* ---------- DXF export ---------- */
function aci(color: string) {
  return PALETTE.find((p) => p.value.toLowerCase() === color?.toLowerCase())?.aci ?? 7;
}
const n = (v: number) => v.toFixed(3);

/** Layer holding the circled numbers in the DXF (can be switched off in any CAD program). */
export const NUMBERS_LAYER = "NUMERI";

export function toDxf(ents: Ent[], opts: { numbersOff?: boolean } = {}): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), String(value));
  // R2000 (AC1015) is the oldest DXF version that can store line thickness (group 370)
  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$ACADVER");
  g(1, "AC1015");
  g(9, "$LWDISPLAY");
  g(290, 1);
  g(0, "ENDSEC");
  // layers: "0" for the drawing, NUMERI for the circled numbers (negative colour = layer off)
  g(0, "SECTION");
  g(2, "TABLES");
  g(0, "TABLE");
  g(2, "LTYPE");
  g(70, 1);
  g(0, "LTYPE");
  g(100, "AcDbSymbolTableRecord");
  g(100, "AcDbLinetypeTableRecord");
  g(2, "CONTINUOUS");
  g(70, 0);
  g(3, "Solid line");
  g(72, 65);
  g(73, 0);
  g(40, "0.0");
  g(0, "ENDTAB");
  g(0, "TABLE");
  g(2, "LAYER");
  g(70, 2);
  for (const [name, color] of [
    ["0", 7],
    [NUMBERS_LAYER, opts.numbersOff ? -7 : 7],
  ] as const) {
    g(0, "LAYER");
    g(100, "AcDbSymbolTableRecord");
    g(100, "AcDbLayerTableRecord");
    g(2, name);
    g(70, 0);
    g(62, color);
    g(6, "CONTINUOUS");
  }
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "ENTITIES");
  const entity = (type: string, sub: string, c: number, w?: number, layer = "0") => {
    g(0, type);
    g(100, "AcDbEntity");
    g(8, layer);
    g(62, c);
    if (w) g(370, widthToLineweight(w));
    g(100, sub);
  };
  const point = (a: number, x: number, y: number) => {
    g(10 + a, n(x));
    g(20 + a, n(-y));
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
  for (const e of ents) {
    if (e.type === "line") {
      line(e.x1, e.y1, e.x2, e.y2, aci(e.color), e.w);
    } else if (e.type === "poly") {
      const c = aci(e.color);
      for (let i = 1; i < e.pts.length; i++)
        line(e.pts[i - 1]!.x, e.pts[i - 1]!.y, e.pts[i]!.x, e.pts[i]!.y, c, e.w);
    } else if (e.type === "rect") {
      const c = aci(e.color),
        r = e.x + e.w,
        b = e.y + e.h;
      line(e.x, e.y, r, e.y, c, e.sw);
      line(r, e.y, r, b, c, e.sw);
      line(r, b, e.x, b, c, e.sw);
      line(e.x, b, e.x, e.y, c, e.sw);
    } else if (e.type === "marker") {
      const c = aci(e.color);
      entity("CIRCLE", "AcDbCircle", c, e.w, NUMBERS_LAYER);
      point(0, e.x, e.y);
      g(40, n(e.r));
      // the number, centred in the circle (horizontal 72 = centre, vertical 73 = middle)
      entity("TEXT", "AcDbText", c, undefined, NUMBERS_LAYER);
      point(0, e.x, e.y);
      g(40, n(markerFontSize(e.r, e.n) * 0.8));
      g(1, e.n);
      g(72, 1);
      point(1, e.x, e.y);
      g(100, "AcDbText");
      g(73, 2);
      // leader line to the point the number refers to, ending in a small dot
      const from = leaderStart(e);
      if (from && e.tx !== undefined && e.ty !== undefined) {
        line(from[0], from[1], e.tx, e.ty, c, e.w, NUMBERS_LAYER);
        entity("CIRCLE", "AcDbCircle", c, e.w, NUMBERS_LAYER);
        point(0, e.tx, e.ty);
        g(40, n(e.r * DOT_FACTOR));
      }
    } else {
      entity("TEXT", "AcDbText", aci(e.color));
      point(0, e.x, e.y + e.size);
      g(40, n(e.size * 0.8));
      g(1, e.text);
      g(50, n(-(e.angle || 0)));
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n");
}
