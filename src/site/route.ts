/** The site's routes (pure: tested). The server serves the same page for each; this picks what it shows. */
export type Route =
  | { page: "lobby"; nav: "lobby" }
  | { page: "watch"; nav: "live"; id: string | null }
  | { page: "replay"; nav: "replays"; id: string }
  | { page: "agent"; nav: ""; name: string }
  | { page: "replays"; nav: "replays" }
  | { page: "unknown"; nav: "" };

/** Paths the match server serves the site at (Bun.serve route patterns). */
export const SITE_PATHS = ["/lobby", "/watch", "/watch/:id", "/replay/:id", "/agent/:name", "/replays"] as const;

export function route(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/lobby" || p === "/") return { page: "lobby", nav: "lobby" };
  if (p === "/replays") return { page: "replays", nav: "replays" };
  if (p === "/watch") return { page: "watch", nav: "live", id: null }; // the Arena live (#64)
  let m = /^\/watch\/(m_[0-9a-f]{8})$/.exec(p);
  if (m) return { page: "watch", nav: "live", id: m[1]! };
  m = /^\/replay\/(m_[0-9a-f]{8})$/.exec(p);
  if (m) return { page: "replay", nav: "replays", id: m[1]! };
  m = /^\/agent\/([^/]{1,80})$/.exec(p);
  if (m) {
    try {
      const name = decodeURIComponent(m[1]!);
      if (/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/.test(name)) return { page: "agent", nav: "", name };
    } catch {
      /* bad escape: unknown */
    }
  }
  return { page: "unknown", nav: "" };
}
