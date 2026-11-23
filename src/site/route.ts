/** The site's routes (pure: tested). The server serves the same page for each; this picks what it shows. */
export type Route =
  | { page: "lobby"; nav: "lobby"; id: string | null }
  | { page: "replay"; nav: "replays"; id: string }
  | { page: "agent"; nav: "leaderboard"; name: string }
  | { page: "replays"; nav: "replays" }
  | { page: "leaderboard"; nav: "leaderboard" }
  | { page: "connect"; nav: "connect" }
  | { page: "redirect"; nav: ""; to: string }
  | { page: "unknown"; nav: "" };

/** Paths the match server serves the site at (Bun.serve route patterns). */
export const SITE_PATHS = ["/lobby", "/watch/:id", "/replay/:id", "/agent/:name", "/replays", "/leaderboard", "/connect"] as const;

/** Old paths and where they went (#106): the server answers them with a redirect; the page does the same if it sees one. */
export const REDIRECTS: Record<string, string> = {
  "/watch": "/lobby",
  "/models": "/leaderboard?view=models",
};

export function route(pathname: string, hash = ""): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (REDIRECTS[p]) return { page: "redirect", nav: "", to: REDIRECTS[p]! };
  // the old JOIN panel's links (/lobby#join, from MCP error messages and old posts)
  if (hash === "#join") return { page: "redirect", nav: "", to: "/connect" };
  if (p === "/lobby" || p === "/") return { page: "lobby", nav: "lobby", id: null };
  if (p === "/replays") return { page: "replays", nav: "replays" };
  if (p === "/leaderboard") return { page: "leaderboard", nav: "leaderboard" };
  if (p === "/connect") return { page: "connect", nav: "connect" };
  // one round live: the lobby's view on that round (#106: /watch and /watch/:id are the lobby)
  let m = /^\/watch\/(m_[0-9a-f]{8})$/.exec(p);
  if (m) return { page: "lobby", nav: "lobby", id: m[1]! };
  m = /^\/replay\/(m_[0-9a-f]{8})$/.exec(p);
  if (m) return { page: "replay", nav: "replays", id: m[1]! };
  m = /^\/agent\/([^/]{1,80})$/.exec(p);
  if (m) {
    try {
      const name = decodeURIComponent(m[1]!);
      if (/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/.test(name)) return { page: "agent", nav: "leaderboard", name };
    } catch {
      /* bad escape: unknown */
    }
  }
  return { page: "unknown", nav: "" };
}
