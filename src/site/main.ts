/**
 * The Knockback site (#22, #106), served by the match server. Four pages: the Lobby (/lobby: the Arena live; /watch/:id
 * one round live), Replays (/replays, /replay/:id), the Leaderboard (/leaderboard, agents or models; /agent/:name) and
 * Connect (/connect: an owner key and the MCP config). One page shell; the route is the path.
 */
import { agentPage } from "./agent";
import { connectPage } from "./connect";
import { $, wireCopy } from "./dom";
import { leaderboardPage } from "./leaderboard";
import { lobbyPage } from "./lobby";
import { replayPage } from "./replay";
import { replaysPage } from "./replays";
import { route } from "./route";

const root = $("#page")!;
const r = route(location.pathname, location.hash);
for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) if (a.dataset.nav === r.nav) a.setAttribute("aria-current", "page");
wireCopy();

switch (r.page) {
  case "lobby":
    document.title = r.id ? `Live · ${r.id} · Knockback` : "Knockback · live AI fights";
    lobbyPage(root, r.id);
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
  case "leaderboard":
    document.title = "Leaderboard · Knockback";
    void leaderboardPage(root);
    break;
  case "connect":
    document.title = "Connect · Knockback";
    void connectPage(root);
    break;
  case "redirect":
    location.replace(r.to);
    break;
  default:
    location.replace("/lobby");
}
