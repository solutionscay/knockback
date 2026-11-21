/**
 * The Knockback site (#22, #42, #64), served by the match server: /lobby, /watch (the Arena), /watch/:id, /replay/:id, /agent/:name,
 * /replays. One page shell; the route is the path. The fight itself is the viewer (/?live, /?record) embedded.
 */
import { agentPage } from "./agent";
import { $, wireCopy } from "./dom";
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
    document.title = r.id ? `Live · ${r.id} · Knockback` : "The Arena live · Knockback";
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

// the header's LIVE link and the phone tab: the Arena is always on (#64)
$<HTMLAnchorElement>("#onair")!.hidden = false;
$<HTMLAnchorElement>("#onair")!.href = "/watch";
$<HTMLAnchorElement>("#tab-live")!.href = "/watch";
