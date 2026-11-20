/**
 * AI providers: each is a function prompt -> text, run as a non-interactive
 * CLI (no tools). Adding a provider = adding one entry to PROVIDERS (or calling
 * registerProvider). Pattern from Crew Split's quick-match runner.
 *
 * No Gemini API, no SDK keys: these CLIs use the operator's own logins.
 */
export type Ask = (prompt: string, signal: AbortSignal) => Promise<string>;

export interface Provider {
  /** shown on the fighter's card, e.g. "claude/haiku" */
  label: string;
  ask: Ask;
}

export class ProviderError extends Error {}

/** Run a CLI with the prompt on stdin (or as an argument), kill it on abort. */
export function cli(command: (prompt: string) => string[], opts: { stdin: boolean; decode?: (stdout: string) => string }): Ask {
  return async (prompt, signal) => {
    signal.throwIfAborted();
    const args = command(prompt);
    const child = Bun.spawn(args, { stdin: opts.stdin ? new Blob([prompt]) : "ignore", stdout: "pipe", stderr: "ignore" });
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    try {
      const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      signal.throwIfAborted();
      if (exit !== 0) throw new ProviderError(`${args[0]} exited with status ${exit}`);
      return opts.decode ? opts.decode(text) : text;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}

/** Grok's headless JSON envelope: {"text": "...", "stopReason": "..."} */
export function grokText(stdout: string): string {
  let env: { text?: unknown; stopReason?: unknown } | null;
  try {
    env = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  if (typeof env?.text === "string" && env.text.trim()) return env.text;
  if (env?.stopReason) throw new ProviderError(`grok returned no text (${String(env.stopReason)})`);
  return stdout;
}

/** Retry once on a provider error if time allows (grok sometimes spends its turn without text). */
function retryOnce(ask: Ask): Ask {
  return async (prompt, signal) => {
    try {
      return await ask(prompt, signal);
    } catch (e) {
      if (signal.aborted || !(e instanceof ProviderError)) throw e;
      return ask(prompt, signal);
    }
  };
}

const SYSTEM = "You are playing a character in Knockback, a cartoon physics brawler. Reply with the requested JSON only. Tools are disabled.";

export const PROVIDERS: Record<string, Provider> = {
  claude: {
    label: "claude/haiku",
    ask: cli(() => ["claude", "-p", "--model", "haiku", "--tools", "", "--safe-mode", "--no-session-persistence"], { stdin: true }),
  },
  codex: {
    label: "codex/gpt-6-luna",
    ask: cli(
      () => ["codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-"],
      { stdin: true },
    ),
  },
  grok: {
    label: "grok/grok-4.6",
    ask: retryOnce(
      cli(
        (prompt) => [
          "grok", "-m", "grok-4.6", "--reasoning-effort", "low", "--output-format", "json", "--tools", "", "--disable-web-search",
          "--no-subagents", "--no-plan", "--permission-mode", "dontAsk", "--max-turns", "3", "--verbatim", "--system-prompt-override", SYSTEM, "-p", prompt,
        ],
        { stdin: false, decode: grokText },
      ),
    ),
  },
};

export function registerProvider(name: string, p: Provider) {
  PROVIDERS[name] = p;
}

/**
 * Stub providers for tests and offline demos: `stub` answers a valid plan,
 * `slow` never answers in time, `junk` answers nonsense, `broken` errors.
 */
export function registerStubs(delayMs = 30) {
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
    });
  registerProvider("stub", {
    label: "stub/test",
    ask: async (prompt, signal) => {
      await wait(delayMs, signal);
      const me = /You are (\w+)/.exec(prompt)?.[1] ?? "someone";
      return `Sure! Here's my plan:\n\`\`\`json\n{"weapons":["rocket","bat"],"target":"weakest","stance":"rush","retaliate":"attacker","why":"stub plan: rush the weakest with rocket and bat","line":"${me} is coming for you."}\n\`\`\``;
    },
  });
  registerProvider("slow", { label: "slow/test", ask: async (_p, signal) => (await wait(600_000, signal), "{}") });
  registerProvider("junk", { label: "junk/test", ask: async () => "I would rather not play today." });
  registerProvider("broken", {
    label: "broken/test",
    ask: async () => {
      throw new ProviderError("broken exited with status 1");
    },
  });
}
