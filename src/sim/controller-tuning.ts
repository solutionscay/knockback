/** Aim noise (perpendicular offset per meter of range): the same for everyone. */
export const AIM_NOISE = 0.07;

/**
 * Anti-stalemate behavior (see also STALEMATE in constants.ts):
 *   calmTicks      cover/distance/item fighters who neither dealt nor took damage this long close in (rush)
 *   peekEvery/For  cover fighters spend peekFor of every peekEvery ticks somewhere with a clear shot
 *   stuckTicks     no progress toward the movement goal this long = stuck: drop the planned jump,
 *                  avoid that surface for avoidTicks, and dig toward the goal for digTicks
 *   linkTicks      a planned jump still "in flight" after this long is abandoned (bounce pads)
 *   unreachTicks   a target with no path and no line of sight this long is skipped for skipTicks
 *   breachAfter    standing still with no line of sight to a target within breachRange this long:
 *                  blast/bash straight through the terrain between us (floors, walls)
 *   pressAfter     in sudden death or the final duel, not having hurt anyone this long: press -
 *                  circle to the target's other side every pressFlip ticks and fire straight at it
 */
export const PATIENCE = { calmTicks: 330, peekEvery: 240, peekFor: 90, stuckTicks: 110, avoidTicks: 300, digTicks: 90, linkTicks: 100, unreachTicks: 180, skipTicks: 360, breachAfter: 90, breachRange: 12, pressAfter: 240, pressFlip: 180 };

/**
 * Pickup hunting (path cost in meters-ish). Unarmed fighters go a long way
 * for any weapon; armed ones detour only for a better one, or for anything
 * when their stance is "item".
 */
export const PICKUP = { unarmedLimit: 70, upgradeLimit: 14, itemStanceLimit: 34, rankCost: 3, healthBelowHp: 50, healthLimit: 16, jetpackLimit: 11, giveUpTicks: 100, skipTicks: 420, seekLimit: 60 };
