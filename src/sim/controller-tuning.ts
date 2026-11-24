/** Aim noise (perpendicular offset per meter of range): the same for everyone. */
export const AIM_NOISE = 0.07;

/**
 * Anti-stalemate behavior (see also STALEMATE in constants.ts):
 *   calmTicks      fighters in any stance but rush who neither dealt nor took damage this long close in (rush);
 *                  overwatch and hold have their own (tactics.stances)
 *   stuckTicks     no progress toward the movement goal this long = stuck: drop the planned jump,
 *                  avoid that surface for avoidTicks, and dig toward the goal for digTicks
 *   linkTicks      a planned jump still "in flight" after this long is abandoned (bounce pads)
 *   unreachTicks   a target with no path and no line of sight this long is skipped for skipTicks
 *   breachAfter    standing still with no line of sight to a target within breachRange this long:
 *                  blast/bash straight through the terrain between us (floors, walls)
 *   pressAfter     in sudden death or the final duel, not having hurt anyone this long: press -
 *                  circle to the target's other side every pressFlip ticks and fire straight at it
 */
export const PATIENCE = { calmTicks: 330, stuckTicks: 110, avoidTicks: 300, digTicks: 90, linkTicks: 100, unreachTicks: 180, skipTicks: 360, breachAfter: 90, breachRange: 12, pressAfter: 240, pressFlip: 180 };

/**
 * Pickup hunting (path cost in meters-ish). Unarmed fighters go a long way
 * for any weapon; armed ones detour only for a better one, or for anything
 * when their stance is "item". #95: lowAmmoShare: carrying this share of a full load or less is "low" -
 * any weapon with more ammo is worth taking, and the nearest one within rearmLimit is worth a trip; a low weapon not
 * fired for dropIdleTicks (house bots) is dropped, so the fighter goes as far as an unarmed one (unarmedLimit) to
 * re-arm; a weapon given up on (giveUpTicks) is tried again after rearmSkipTicks, not skipTicks. One slot: a fighter
 * that has fired nothing for noShotTicks with its target within noShotReach (a rocket in a rival's face) closes in
 * with fists until it lands one. saveShotsReach: low on ammo, a rival this close is fought with fists (the last shots kept for range).
 * fightReach (#109): bare-handed, a rival this close (or a fight in the last half second) is fought with fists; else a
 * weapon comes first, whatever the stance.
 */
export const PICKUP = { unarmedLimit: 70, upgradeLimit: 14, itemStanceLimit: 34, rankCost: 3, healthBelowHp: 50, healthLimit: 16, jetpackLimit: 11, giveUpTicks: 100, skipTicks: 420, seekLimit: 60, lowAmmoShare: 0.25, rearmLimit: 40, dropIdleTicks: 480, saveShotsReach: 1.3, rearmSkipTicks: 150, noShotTicks: 240, noShotReach: 4.5, fightReach: 3 };

export const WALL_PURSUIT = { routeTicks: 48, attackTicks: 88, retargetTicks: 175, flankTicks: 174, flankPeriod: 150, flankFor: 85 };
export const RULE_EVAL = { everyTicks: 12, minOnTicks: 60, minOffTicks: 60, ledgeM: 2, barrelM: 3, chaseTicks: 180, hitTicks: 180, itemCost: 12 };
