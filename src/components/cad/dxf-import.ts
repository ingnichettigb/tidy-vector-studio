import DxfParser from "dxf-parser";
import type { Ent } from "./cad-data";

const ACI: Record<number, string> = {
  1: "#ff4d4d",
  2: "#b8860b",
  3: "#3ddc84",
  4: "#3dd6dc",
  5: "#4da3ff",
  6: "#e05cff",
  7: "#111111",
  8: "#8a8a8a",
  9: "#777777",
};

type P = { x: number; y: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEnt = any;

function colorOf(e: AnyEnt, layers: Record<string, AnyEnt>): string {
  let idx: number | undefined = e.colorIndex;
  if (idx === undefined || idx === 256 || idx === 0) idx = layers[e.layer]?.colorIndex;
  if (idx !== undefined && ACI[Math.abs(idx)]) return ACI[Math.abs(idx)]!;
  if (typeof e.color === "number" && e.color !== 0 && e.color !== 0xffffff && e.color < 0xe0e0e0)
    return "#" + e.color.toString(16).padStart(6, "0");
  return "#111111";
}

/** Convert DXF text to editor entities (Y axis flipped for screen). */
export function parseDxf(text: string): Ent[] {
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error("DXF non valido");
  const layers = (dxf.tables?.layer?.layers ?? {}) as Record<string, AnyEnt>;
  const blocks = (dxf.blocks ?? {}) as Record<string, AnyEnt>;
  const out: Ent[] = [];

  const walk = (ents: AnyEnt[], tf: (p: P) => P, scale: number, depth: number) => {
    for (const e of ents ?? []) {
      const c = colorOf(e, layers);
      const seg = (a: P, b: P) => {
        const A = tf(a),
          B = tf(b);
        out.push({ type: "line", x1: A.x, y1: -A.y, x2: B.x, y2: -B.y, color: c, w: 1 });
      };
      // One entity per polyline/circle/arc instead of one per segment: far fewer entities.
      const poly = (pts: P[], closed = false) => {
        if (pts.length < 2) return;
        const tp = pts.map((q) => {
          const A = tf(q);
          return { x: A.x, y: -A.y };
        });
        if (closed && tp.length > 2) tp.push({ ...tp[0]! });
        if (tp.length === 2) {
          out.push({
            type: "line",
            x1: tp[0]!.x,
            y1: tp[0]!.y,
            x2: tp[1]!.x,
            y2: tp[1]!.y,
            color: c,
            w: 1,
          });
          return;
        }
        out.push({ type: "poly", pts: tp, color: c, w: 1 });
      };
      const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
        if (a1 < a0) a1 += Math.PI * 2;
        const n = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 48));
        const pts: P[] = [];
        for (let i = 0; i <= n; i++) {
          const a = a0 + ((a1 - a0) * i) / n;
          pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        poly(pts);
      };
      switch (e.type) {
        case "LINE":
          if (e.vertices?.length >= 2) seg(e.vertices[0], e.vertices[1]);
          break;
        case "LWPOLYLINE":
        case "POLYLINE": {
          const v = e.vertices ?? [];
          poly(v, !!e.shape);
          break;
        }
        case "CIRCLE":
          arc(e.center.x, e.center.y, e.radius, 0, Math.PI * 2);
          break;
        case "ARC":
          arc(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle);
          break;
        case "TEXT":
        case "MTEXT": {
          const p = e.startPoint ?? e.position;
          if (!p) break;
          const raw = String(e.text ?? "")
            .replace(/\\P/g, " ")
            .replace(/\\[A-Za-z][^;]*;/g, "")
            .replace(/[{}]/g, "");
          const h = (e.textHeight ?? e.height ?? 2.5) * scale;
          const P0 = tf(p);
          out.push({
            type: "text",
            x: P0.x,
            y: -P0.y - h,
            text: raw,
            size: h,
            color: c,
            angle: -(e.rotation ?? 0),
          });
          break;
        }
        case "INSERT": {
          const b = blocks[e.name];
          if (!b || depth > 6) break;
          const sx = e.xScale ?? 1,
            sy = e.yScale ?? 1,
            rot = ((e.rotation ?? 0) * Math.PI) / 180;
          const bp = b.position ?? { x: 0, y: 0 },
            ip = e.position;
          const cos = Math.cos(rot),
            sin = Math.sin(rot);
          walk(
            b.entities,
            (q) => {
              const x = (q.x - bp.x) * sx,
                y = (q.y - bp.y) * sy;
              return tf({ x: ip.x + x * cos - y * sin, y: ip.y + x * sin + y * cos });
            },
            scale * Math.abs(sx),
            depth + 1,
          );
          break;
        }
      }
    }
  };
  walk(dxf.entities, (p) => p, 1, 0);
  return out;
}
