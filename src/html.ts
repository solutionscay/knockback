/**
 * Two string helpers that the viewer, the site and the server all use to build HTML and SVG text.
 * Pure: no DOM, no Pixi, no node.
 */

/** Escape a value for HTML text or a quoted attribute (& < > " ' become numeric entities). */
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A 0xRRGGBB colour as CSS "#rrggbb". */
export const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
