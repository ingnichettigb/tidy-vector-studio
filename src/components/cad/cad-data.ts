import type { FabricObject } from "fabric";

export type Tool = "select" | "pan" | "line" | "rect";

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
  | { type: "rect"; x: number; y: number; w: number; h: number; color: string; sw?: number }
  | { type: "text"; x: number; y: number; text: string; size: number; color: string; angle?: number };

const W = "#111111", DIM = "#4da3ff", TXT = "#c2410c", DOOR = "#3ddc84";

function dim(x1: number, y1: number, x2: number, y2: number, label: string, off: number): Ent[] {
  const horiz = y1 === y2;
  if (horiz) {
    const y = y1 + off;
    return [
      { type: "line", x1, y1: y, x2, y2: y, color: DIM, w: 1 },
      { type: "line", x1, y1: y - 6, x2: x1, y2: y + 6, color: DIM, w: 1 },
      { type: "line", x1: x2, y1: y - 6, x2, y2: y + 6, color: DIM, w: 1 },
      { type: "text", x: (x1 + x2) / 2 - label.length * 4, y: y - 18, text: label, size: 13, color: DIM },
    ];
  }
  const x = x1 + off;
  return [
    { type: "line", x1: x, y1, x2: x, y2, color: DIM, w: 1 },
    { type: "line", x1: x - 6, y1, x2: x + 6, y2: y1, color: DIM, w: 1 },
    { type: "line", x1: x - 6, y1: y2, x2: x + 6, y2, color: DIM, w: 1 },
    { type: "text", x: x - 6, y: (y1 + y2) / 2 + label.length * 4, text: label, size: 13, color: DIM, angle: -90 },
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
  const rooms = variant === 1
    ? [["UFFICIO 1", 140, 130], ["SALA RIUNIONI", 440, 200], ["ARCHIVIO", 640, 250], ["RECEPTION", 100, 390]]
    : [["SOGGIORNO", 130, 130], ["CAMERA", 560, 300], ["CUCINA", 110, 300], ["BAGNO", 290, 400]];
  rooms.forEach(([t, x, y]) => {
    e.push({ type: "text", x: x as number, y: y as number, text: t as string, size: 20, color: TXT });
    e.push({ type: "text", x: x as number, y: (y as number) + 26, text: "h = 2.70 m", size: 12, color: TXT });
  });
  e.push({ type: "text", x: 0, y: 580, text: variant === 1 ? "PIANTA PIANO TERRA - FILE IMPORTATO" : "PIANTA ABITAZIONE - SCALA 1:100", size: 18, color: W });
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

export function toDxf(objs: FabricObject[]): string {
  const out: string[] = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  const line = (x1: number, y1: number, x2: number, y2: number, c: number) =>
    out.push("0", "LINE", "8", "0", "62", String(c), "10", n(x1), "20", n(-y1), "11", n(x2), "21", n(-y2));
  for (const o of objs) {
    const t = o.type;
    if (t === "line") {
      const l = o as unknown as { x1: number; y1: number; x2: number; y2: number; stroke: string };
      line(l.x1, l.y1, l.x2, l.y2, aci(l.stroke));
    } else if (t === "rect") {
      const r = o as unknown as { left: number; top: number; width: number; height: number; stroke: string };
      const c = aci(r.stroke), x = r.left, y = r.top, w = r.width, h = r.height;
      line(x, y, x + w, y, c); line(x + w, y, x + w, y + h, c); line(x + w, y + h, x, y + h, c); line(x, y + h, x, y, c);
    } else if (t === "text") {
      const s = o as unknown as { left: number; top: number; text: string; fontSize: number; fill: string; angle: number };
      out.push("0", "TEXT", "8", "0", "62", String(aci(s.fill)), "10", n(s.left), "20", n(-(s.top + s.fontSize)), "40", n(s.fontSize * 0.8), "1", s.text, "50", n(-(s.angle || 0)));
    }
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\n");
}
