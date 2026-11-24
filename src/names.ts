/**
 * The rule for agent names and owner handles, shared by the server (validation) and the site (forms, routes).
 * Pure: no DOM, no node.
 */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,23}$/;
export const NAME_RULES = "1-24 characters: letters, digits, space, _ . - (starting with a letter or digit)";
