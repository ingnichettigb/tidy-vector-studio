import type { Ent, Sheet } from "./cad-data";

/**
 * The project file (.json): everything needed to reopen the work as it was left, unlike the
 * DXF which only holds the drawing. Undo history is not saved.
 */

export const PROJECT_APP = "pulizia-dwg";
export const PROJECT_VERSION = 1;

export type MarkerSizeName = "S" | "M" | "L";

export type Project = {
  app: typeof PROJECT_APP;
  version: number;
  savedAt: string;
  /** name of the drawing this project came from (used to name exports) */
  name: string;
  ents: Ent[];
  numbersHidden: boolean;
  sheet: Sheet | null;
  sheetLocked: boolean;
  /** positions in `ents` of the elements the frame was fitted to ("Solo i N scelti") */
  only: number[] | null;
  onlyChecked: boolean;
  settings: { thickness: number; markerSize: MarkerSizeName; markerNext: number; color: string };
  /** canvas viewport transform [zoom, 0, 0, zoom, panX, panY] */
  view: number[] | null;
};

type Keys<K extends string> = Partial<Record<K, unknown>>;
type RawEnt = Keys<
  | "type"
  | "color"
  | "x1"
  | "y1"
  | "x2"
  | "y2"
  | "w"
  | "pts"
  | "x"
  | "y"
  | "h"
  | "sw"
  | "r"
  | "n"
  | "tx"
  | "ty"
  | "text"
  | "size"
  | "angle"
>;
type RawProject = Keys<
  | "app"
  | "version"
  | "savedAt"
  | "name"
  | "ents"
  | "numbersHidden"
  | "sheet"
  | "sheetLocked"
  | "only"
  | "onlyChecked"
  | "settings"
  | "view"
>;
type RawSheet = Keys<"x" | "y" | "w" | "h" | "land">;
type RawSettings = Keys<"thickness" | "markerSize" | "markerNext" | "color">;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const optNum = (v: unknown) => v === undefined || num(v);

/** True for a well-formed entity (anything else in a hand-edited file is dropped). */
export function isEnt(v: unknown): v is Ent {
  if (!v || typeof v !== "object") return false;
  const e = v as RawEnt;
  if (!str(e.color)) return false;
  switch (e.type) {
    case "line":
      return num(e.x1) && num(e.y1) && num(e.x2) && num(e.y2) && optNum(e.w);
    case "poly":
      return (
        Array.isArray(e.pts) &&
        e.pts.length >= 2 &&
        e.pts.every((p) => !!p && num((p as { x: unknown }).x) && num((p as { y: unknown }).y)) &&
        optNum(e.w)
      );
    case "rect":
      return num(e.x) && num(e.y) && num(e.w) && num(e.h) && optNum(e.sw);
    case "marker":
      return (
        num(e.x) &&
        num(e.y) &&
        num(e.r) &&
        e.r > 0 &&
        str(e.n) &&
        optNum(e.w) &&
        optNum(e.tx) &&
        optNum(e.ty) &&
        (e.tx === undefined) === (e.ty === undefined)
      );
    case "text":
      return num(e.x) && num(e.y) && str(e.text) && num(e.size) && optNum(e.angle);
    default:
      return false;
  }
}

export function buildProject(p: Omit<Project, "app" | "version" | "savedAt">): Project {
  return { app: PROJECT_APP, version: PROJECT_VERSION, savedAt: new Date().toISOString(), ...p };
}

export type ParseResult =
  { ok: true; project: Project; dropped: number } | { ok: false; error: string };

export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "il file non è un JSON valido" };
  }
  if (!raw || typeof raw !== "object" || (raw as RawProject).app !== PROJECT_APP)
    return { ok: false, error: "non è un progetto di Pulizia DWG" };
  const r = raw as RawProject;
  if (!num(r.version) || r.version > PROJECT_VERSION)
    return { ok: false, error: "il progetto è stato salvato da una versione più recente" };
  if (!Array.isArray(r.ents)) return { ok: false, error: "nel progetto manca il disegno" };

  // keep only valid entities, remembering where each one went so `only` can follow
  const ents: Ent[] = [];
  const newIndex = new Map<number, number>();
  r.ents.forEach((e, i) => {
    if (isEnt(e)) {
      newIndex.set(i, ents.length);
      ents.push(e);
    }
  });

  const s = r.sheet as RawSheet | null | undefined;
  const sheet: Sheet | null =
    s && num(s.x) && num(s.y) && num(s.w) && s.w > 0 && num(s.h) && s.h > 0
      ? { x: s.x, y: s.y, w: s.w, h: s.h, land: s.land === true }
      : null;

  const only = Array.isArray(r.only)
    ? r.only.filter((i): i is number => num(i) && newIndex.has(i)).map((i) => newIndex.get(i)!)
    : null;

  const st = (r.settings ?? {}) as RawSettings;
  const view =
    Array.isArray(r.view) && r.view.length === 6 && r.view.every(num) && (r.view[0] as number) > 0
      ? (r.view as number[])
      : null;

  return {
    ok: true,
    dropped: r.ents.length - ents.length,
    project: {
      app: PROJECT_APP,
      version: r.version,
      savedAt: str(r.savedAt) ? r.savedAt : "",
      name: str(r.name) ? r.name : "disegno",
      ents,
      numbersHidden: r.numbersHidden === true,
      sheet,
      sheetLocked: sheet !== null && r.sheetLocked === true,
      only: sheet && only && only.length ? only : null,
      onlyChecked: r.onlyChecked !== false,
      settings: {
        thickness: num(st.thickness) && st.thickness > 0 ? st.thickness : 3,
        markerSize: st.markerSize === "S" || st.markerSize === "L" ? st.markerSize : "M",
        markerNext: num(st.markerNext) && st.markerNext >= 0 ? Math.floor(st.markerNext) : 0,
        color: str(st.color) ? st.color : "#111111",
      },
      view,
    },
  };
}
