# Plan rules

A plan can carry up to **4 conditional rules**. Each one reads "**when** something is true, **do** this", for as long as it stays true. Rules are **data, not code**: an AI picks every part from fixed lists, never writes expressions. The controller evaluates them during the round, deterministically (#6).

```json
"rules": [
  { "when": "holds", "who": "anyone", "item": "rocket", "do": "target", "label": "chase the rocket holder" },
  { "when": "my_health_below", "value": 30, "do": "seek", "item": "health", "label": "patch up" },
  { "when": "near_ledge", "who": "enemy", "do": "use", "item": "grapple", "label": "hook them off" },
  { "when": "on_streak", "who": "enemy", "value": 2, "do": "avoid", "label": "dodge the hot hand" }
]
```

The `rules` key is optional. Plans without rules work as before.

## Triggers (`when`)

| when | parameters | true when |
|---|---|---|
| `holds` | `who`, `item` (a weapon or jetpack) | a fighter in `who` carries the weapon or has jetpack fuel left |
| `my_health_below` | `value` (10–90) | my health % is less than `value` |
| `health_below` | `who`, `value` (10–90) | a fighter in `who` has health % less than `value` |
| `near_ledge` | `who` | a fighter in `who` stands within 2 m of a pit edge or the level edge |
| `near_barrel` | `who` | a fighter in `who` is within 3 m of an explosive barrel or TNT |
| `on_streak` | `who`, `value` (1–3) | a fighter in `who` has `value` or more knockouts this round |
| `chasing_me` | `who` | a fighter in `who` has had me as its target for 3 s or more |
| `hit_me` | `who` | a fighter in `who` hit me within the last 3 s |
| `item_near` | `item` (any pickup or power-up) | that pickup is within 12 m of path cost |
| `alone_with` | none | only one other fighter is alive |

**`who`** can be:
- `anyone`;
- `enemy`: anyone but me;
- `target`: my current target;
- a fighter's name, which is stored as that fighter's seat number. A name can't be your own.

**Weapons:** `rocket`, `shotgun`, `bat`, `grenade`, `grapple` (`hook` also works), `flamethrower` (`flamer` also works), `mine`, `railgun`, `hammer`. **Pickups:** the weapons plus `health`, `shield`, `speed`, `heavy`, `damage`, `jump`, `jetpack`.

## Actions (`do`)

| do | parameters | effect while the rule is active |
|---|---|---|
| `target` | none | target the fighter that made the trigger true (the closest one if more than one does) |
| `avoid` | none | keep away from that fighter (distance stance relative to it); never target it |
| `seek` | `item` (a pickup) | go for the item (the pickup hunt with a high limit) |
| `use` | `item` (a weapon or jetpack) | prefer the weapon when carried, or make the fighter more willing to spend jetpack fuel on a climb or chase |
| `stance` | `stance`: rush, distance, cover or item | play that stance |
| `retaliate` | `retaliate`: attacker, turn or ignore | use that retaliate setting |

**Which subjects work:**
- `target` and `avoid` need a trigger about a fighter: `holds`, `health_below`, `near_ledge`, `near_barrel`, `on_streak`, `chasing_me`, `hit_me` or `alone_with`.
- With `my_health_below` or `item_near` there's no fighter to aim at, so those rules are rejected.

**Which `item` is which:** in the AI's JSON, `item` belongs to the **trigger** for `holds` and `item_near`, and to the **action** otherwise. When the trigger already uses `item`, name the action's item with `do_item`. For example, "if my target holds a bat, use the shotgun":

```json
{ "when": "holds", "who": "target", "item": "bat", "do": "use", "do_item": "shotgun" }
```

For `item_near` + `seek`, the action defaults to the trigger's item.

**`label`:**
- at most 40 characters, cleaned like a line;
- without one, a label is made from the rule (for example, "Zapko has rocket: go for them").

## Priorities and limits

- **At most 4 rules.** The list order is the priority: the first rule is the most important.
- **One winner per kind of action.** At any time, at most one rule changes the target (`target` or `avoid`) and at most one changes the stance. The highest active rule wins each. `use`, `seek` and `retaliate` rules can be active alongside them.
- **Hysteresis:** a rule stays active for at least 1 s (60 ticks) after it starts, and can start again only 1 s after it stops. This stops flicker.
- **The sim's guards come first:**
  - the zone;
  - "unarmed: go for any weapon";
  - the stalemate rules (sudden death and the final duel close in);
  - the back-attack reflex.

## Validation

- **AI answers** are validated in `src/ai/parse.ts` (`parseRules`):
  - An unknown value, a parameter out of range, a name that isn't a fighter (or is yourself), a missing parameter, an action that needs a fighter after a trigger without one, or a duplicate rule **drops only that rule**. The plan stays valid.
  - More than 4 rules: the first 4 are kept.
  - Every problem goes into the decision meta (`ruleProblems`), and the next prompt mentions it (#7).
- **Records and the live stream** go through the same checks (`checkRule` in `src/sim/rules.ts`) in `src/viewer/sanitize.ts`.

## Records

Match records store fighter identities and plans, including rules. Rules store seat numbers in `who` and the action's item in `doItem`.

### Replay

A record replays only when each round reaches its recorded final state hash. A replay that diverges is refused (`ReplayDivergedError` for a match, `FightDivergedError` for a fight). There is no fallback and no summary card. A sim change that moves the hashes leaves older records unreplayable; pre-alpha, they are not kept in the app.
