/**
 * The level's plush terrain (#92): every material's cells and top edges per theme, rendered in Blender
 * (tools/art/plush_level.py) and packed like the world sprites (tools/art/world_pack.py: KTX2 when the GPU takes a
 * block format, else WebP). Per match: a round loads its theme's atlas and the shared one (cracks, char, edge piping,
 * the chain anchor) and frees the other themes. View only.
 */
import { Assets, Rectangle, Texture } from "pixi.js";
import type { Theme } from "../sim/level-config";
import { LEVEL_LAYOUT, LEVEL_URLS } from "./art/level/layout";
import { plushFormat } from "./plush-bot";

interface FrameMeta { g: string; x: number; y: number; w: number; h: number; ax: number; ay: number; ppm: number }
type Key = keyof typeof LEVEL_URLS;
const FRAMES = LEVEL_LAYOUT.frames as unknown as Record<string, FrameMeta>;

/** A loaded frame: its texture and its size in game meters (tiles anchor top-left; the anchor sprite on ax, ay). */
export interface LevelFrame { tex: Texture; w: number; h: number; ax: number; ay: number }

const loaded = new Map<Key, Map<string, LevelFrame>>();
const pending = new Map<Key, Promise<void>>();
const url = (k: Key) => LEVEL_URLS[k][plushFormat() ?? "webp"];

function load(k: Key): Promise<void> {
  if (loaded.has(k)) return Promise.resolve();
  let p = pending.get(k);
  if (!p) {
    const fmt = plushFormat() ?? "webp";
    const g = k === "common" ? "level" : `level-${k}`;
    p = Assets.load<Texture>({ src: url(k), loadParser: fmt === "ktx2" ? "loadKTX2" : undefined }).then((base) => {
      const m = new Map<string, LevelFrame>();
      for (const [n, f] of Object.entries(FRAMES)) {
        if (f.g !== g) continue;
        const tex = new Texture({ source: base.source, frame: new Rectangle(f.x, f.y, f.w, f.h) });
        m.set(n.includes(":") ? n.slice(n.indexOf(":") + 1) : n, { tex, w: f.w / f.ppm, h: f.h / f.ppm, ax: f.ax / f.ppm, ay: f.ay / f.ppm });
      }
      if (pending.has(k)) loaded.set(k, m);
      pending.delete(k);
    });
    pending.set(k, p);
  }
  return p;
}

/** A new round: load its theme (and the shared overlays), free the other themes. */
export function levelRound(theme: Theme): Promise<void> {
  for (const k of [...loaded.keys()]) {
    if (k === "common" || k === theme) continue;
    loaded.delete(k);
    void Assets.unload(url(k));
  }
  return Promise.all([load("common"), load(theme)]).then(() => undefined);
}

/** Load a theme (and the shared overlays) and keep the rest (the lab shows every theme at once). */
export const levelLoad = (theme: Theme): Promise<void> => Promise.all([load("common"), load(theme)]).then(() => undefined);

/** Wait until no level atlas is loading; true if one was. */
export async function levelSettle(): Promise<boolean> {
  if (!pending.size) return false;
  while (pending.size) await Promise.all([...pending.values()]);
  return true;
}

/** Are this theme's terrain frames (and the shared ones) loaded? */
export const levelReady = (theme: Theme) => loaded.has(theme) && loaded.has("common");

/** A theme frame (c-<mat>-<v>, t-<mat>) or a shared one (k-<stage>-<v>, char-<v>, e-l, e-r, e-b, anchor), or null. */
export function levelFrame(theme: Theme, name: string): LevelFrame | null {
  return loaded.get(theme)?.get(name) ?? loaded.get("common")?.get(name) ?? null;
}

/** What is loaded: atlas names and their GPU bytes (block formats: 1 byte per pixel; WebP: 4). */
export function levelMemory(only?: Theme): { atlases: string[]; bytes: number } {
  let bytes = 0;
  const keys = [...loaded.keys()].filter((k) => !only || k === only || k === "common");
  const atlases = keys.map(String);
  for (const k of keys) {
    const [w, h] = (LEVEL_LAYOUT.sizes as unknown as Record<string, [number, number]>)[k === "common" ? "level" : `level-${k}`]!;
    bytes += w * h * (plushFormat() === "ktx2" ? 1 : 4);
  }
  return { atlases, bytes };
}
