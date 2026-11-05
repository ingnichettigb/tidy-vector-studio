/**
 * =======================================================================
 * File:        dwg-geometry.ts
 * Percorso:    (src/components/cad/dwg-geometry.ts)
 * Revisione:   Rev. 1.0
 * Data:        05/11/2026
 * -----------------------------------------------------------------------
 * Storico Revisioni (max 10 voci, oltre la decima si sostituisce la più vecchia):
 * [05/11/2026] Rev. 1.0 - Funzioni di geometria pure per l'importazione DWG: archi, bulge,
 *                         polilinee, ellissi, spline (B-spline razionali), pulizia testi.
 *                         Separate da dwg-import.ts per tenere i file sotto le 400 righe.
 * =======================================================================
 */

export type P = { x: number; y: number };
export type V = P & { bulge?: number };

/** Testo di AutoCAD -> testo semplice (codici MTEXT e simboli %%c %%d %%p). */
export function plainText(raw: string): string {
  return String(raw ?? "")
    .replace(/\\P/g, " ")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/%%[cC]/g, "Ø")
    .replace(/%%[dD]/g, "°")
    .replace(/%%[pP]/g, "±")
    .replace(/[{}]/g, "")
    .trim();
}

/** Punti di un arco in senso antiorario da a0 ad a1 (radianti), come in dxf-import.ts. */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): P[] {
  if (a1 < a0) a1 += Math.PI * 2;
  const n = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 48));
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Punti intermedi (estremi esclusi) di un lato di polilinea con "bulge" (arco). */
export function bulgePoints(p1: P, p2: P, bulge: number): P[] {
  const dx = p2.x - p1.x,
    dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  if (!bulge || d < 1e-9) return [];
  const theta = 4 * Math.atan(bulge); // angolo al centro, con segno (+ antiorario)
  const h = d / 2 / Math.tan(theta / 2); // distanza del centro dalla corda, a sinistra se > 0
  const cx = (p1.x + p2.x) / 2 - (dy / d) * h,
    cy = (p1.y + p2.y) / 2 + (dx / d) * h;
  const r = Math.hypot(p1.x - cx, p1.y - cy);
  const a0 = Math.atan2(p1.y - cy, p1.x - cx);
  const n = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * 48));
  const out: P[] = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Punti di una polilinea con i lati ad arco; se chiusa, l'ultimo punto torna al primo. */
export function polylinePoints(v: V[], closed: boolean): P[] {
  const pts: P[] = [];
  const last = closed ? v.length : v.length - 1;
  for (let i = 0; i < last; i++) {
    const a = v[i]!,
      b = v[(i + 1) % v.length]!;
    pts.push({ x: a.x, y: a.y }, ...bulgePoints(a, b, a.bulge ?? 0));
  }
  const end = closed ? v[0]! : v[v.length - 1]!;
  pts.push({ x: end.x, y: end.y });
  return pts;
}

/**
 * Ellisse o arco di ellisse. `major` è il vettore dal centro a un estremo dell'asse maggiore,
 * `ratio` il rapporto asse minore / maggiore, a0 e a1 i parametri di inizio e fine (radianti).
 */
export function ellipsePoints(c: P, major: P, ratio: number, a0: number, a1: number): P[] {
  if (a1 <= a0) a1 += Math.PI * 2;
  const mx = -major.y * ratio,
    my = major.x * ratio; // asse minore: il maggiore ruotato di 90° e accorciato
  const n = Math.max(16, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 72));
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    pts.push({
      x: c.x + major.x * Math.cos(t) + mx * Math.sin(t),
      y: c.y + major.y * Math.cos(t) + my * Math.sin(t),
    });
  }
  return pts;
}

export type SplineData = {
  degree: number;
  knots?: number[];
  weights?: number[];
  controlPoints?: P[];
  fitPoints?: P[];
};

/** Punti di una spline: B-spline razionale dai punti di controllo, o la linea per i punti di passaggio. */
export function splinePoints(s: SplineData): P[] {
  const cp = s.controlPoints ?? [];
  const fit = s.fitPoints ?? [];
  const p = Math.floor(s.degree || 0);
  const knots = s.knots ?? [];
  const n = cp.length - 1;
  const valid = p >= 1 && n >= p && knots.length === n + p + 2;
  if (!valid) return (cp.length > 1 ? cp : fit).map((q) => ({ x: q.x, y: q.y }));

  const w = s.weights && s.weights.length === cp.length ? s.weights : cp.map(() => 1);
  const t0 = knots[p]!,
    t1 = knots[n + 1]!;
  const samples = Math.min(400, Math.max(16, cp.length * 8));
  const out: P[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i === samples ? t1 - (t1 - t0) * 1e-9 : t0 + ((t1 - t0) * i) / samples;
    let k = p;
    while (k < n && knots[k + 1]! <= t) k++; // intervallo dei nodi che contiene t
    // algoritmo di de Boor, in coordinate omogenee (x*w, y*w, w)
    const d: number[][] = [];
    for (let j = 0; j <= p; j++) {
      const q = cp[j + k - p]!,
        ww = w[j + k - p]!;
      d.push([q.x * ww, q.y * ww, ww]);
    }
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const den = knots[j + 1 + k - r]! - knots[j + k - p]!;
        const a = den > 1e-12 ? (t - knots[j + k - p]!) / den : 0;
        const lo = d[j - 1]!,
          hi = d[j]!;
        d[j] = [
          (1 - a) * lo[0]! + a * hi[0]!,
          (1 - a) * lo[1]! + a * hi[1]!,
          (1 - a) * lo[2]! + a * hi[2]!,
        ];
      }
    const r = d[p]!;
    if (r[2]! > 1e-12) out.push({ x: r[0]! / r[2]!, y: r[1]! / r[2]! });
  }
  return out;
}
