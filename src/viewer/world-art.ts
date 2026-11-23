/**
 * The world's sprites (#87): pickups, props and projectiles rendered in Blender in the plush brawler's toy style
 * (tools/art/plush_world.py), packed like the fighters (tools/art/world_pack.py: KTX2 on a GPU that takes BC7, ASTC
 * or ETC2, else WebP; the format plush-bot.ts picked). The atlases are small, so they load once, before the first
 * match. View only.
 */
import { Assets, Rectangle, type Sprite, Texture } from "pixi.js";
import { WORLD_LAYOUT, WORLD_URLS } from "./art/world/layout";
import { plushFormat } from "./plush-bot";

export type WorldFrame = keyof typeof WORLD_LAYOUT.frames;
type Group = keyof typeof WORLD_URLS;
interface FrameMeta { g: string; x: number; y: number; w: number; h: number; ax: number; ay: number; ppm: number }
const frame = (n: string) => (WORLD_LAYOUT.frames as unknown as Record<string, FrameMeta | undefined>)[n];

const tex = new Map<string, Texture>();

/** Load the world atlases (once; after initPlushArt, which picks the format). */
export async function initWorldArt(): Promise<void> {
  if (tex.size) return;
  const fmt = plushFormat() ?? "webp";
  const groups = Object.keys(WORLD_URLS) as Group[];
  const bases = await Promise.all(groups.map((g) => Assets.load<Texture>({ src: WORLD_URLS[g][fmt], loadParser: fmt === "ktx2" ? "loadKTX2" : undefined })));
  groups.forEach((g, i) => {
    for (const [n, f] of Object.entries(WORLD_LAYOUT.frames as unknown as Record<string, FrameMeta>)) {
      if (f.g === g) tex.set(n, new Texture({ source: bases[i]!.source, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    }
  });
}

/** Is there a world sprite of this name (and is it loaded)? */
export const hasWorldFrame = (name: string) => tex.has(name);

/**
 * Show frame `name` on sprite `s`: its anchor on the object's center, sized in meters at the frame's own scale, times
 * `kx`, `ky` (a prop the ruleset made bigger or smaller than the model). False (sprite hidden) if there is none.
 */
export function setWorldFrame(s: Sprite, name: string, kx = 1, ky = kx): boolean {
  const t = tex.get(name), f = frame(name);
  s.visible = !!t && !!f;
  if (!t || !f) return false;
  if (s.texture !== t) s.texture = t;
  s.anchor.set(f.ax / f.w, f.ay / f.h);
  s.scale.set(kx / f.ppm, ky / f.ppm);
  return true;
}
