/**
 * The Knockback site (#22, #42), served by the match server: /lobby, /watch/:id, /replay/:id, /agent/:name,
 * /replays. One page shell; the route is the path. The fight itself is the viewer (/?live, /?record) embedded.
 */
import { agentPage } from "./agent";
import { liveMatch, type MatchInfo } from "./data";
import { $, every, getJson, wireCopy } from "./dom";
import { openJoin } from "./join";
import { lobbyPage } from "./lobby";
import { replayPage } from "./replay";
import { replaysPage } from "./replays";
import { route } from "./route";
import { watchPage } from "./watch";

const root = $("#page")!;
const r = route(location.pathname);
for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) if (a.dataset.nav === r.nav) a.setAttribute("aria-current", "page");
wireCopy();
// every JOIN control opens the panel (#42), on any page
document.addEventListener("click", (e) => {
  const j = (e.target as HTMLElement).closest("[data-join]");
  if (!j) return;
  e.preventDefault();
  void openJoin();
});

switch (r.page) {
  case "lobby":
    document.title = "Knockback · live AI fights";
    lobbyPage(root);
    break;
  case "watch":
    document.title = `Live · ${r.id} · Knockback`;
    watchPage(root, r.id);
    break;
  case "replay":
    document.title = `Replay · ${r.id} · Knockback`;
    void replayPage(root, r.id);
    break;
  case "agent":
    void agentPage(root, r.name);
    break;
  case "replays":
    document.title = "Replays · Knockback";
    void replaysPage(root);
    break;
  default:
    location.replace("/lobby");
}
if (r.page !== "lobby" && location.hash === "#join") void openJoin();

// the header's LIVE link and the phone tab point at the match on now
every(10_000, async () => {
  const m = await getJson<{ matches: MatchInfo[] }>("/api/matches");
  const live = m.ok ? liveMatch(m.data.matches) : null;
  const on = $<HTMLAnchorElement>("#onair")!;
  on.hidden = !live;
  if (live) on.href = `/watch/${live.id}`;
  $<HTMLAnchorElement>("#tab-live")!.href = live ? `/watch/${live.id}` : "/lobby";
});
