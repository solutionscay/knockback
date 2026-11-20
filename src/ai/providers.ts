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
  /** how long to wait for an answer before the house bot stands in (default DEFAULT_DEADLINE_MS) */
  deadlineMs?: number;
  /** no answer after this long: start a second, identical call; the first answer wins (cuts tail latency) */
  hedgeAfterMs?: number;
}

/**
 * Ask a provider, hedged if it has hedgeAfterMs: when the first call is
 * still out after that long, a second identical call starts and the first
 * answer wins (the other is aborted). An error from one call waits for the
 * other if it is running. `signal` aborts everything.
 */
export function askHedged(p: Provider, prompt: string, signal: AbortSignal): Promise<{ text: string; hedged: boolean }> {
  if (!p.hedgeAfterMs) return p.ask(prompt, signal).then((text) => ({ text, hedged: false }));
  return new Promise((resolve, reject) => {
    const ctls: AbortController[] = [];
    let done = false;
    let running = 0;
    let hedged = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      for (const c of ctls) c.abort();
    };
    const start = () => {
      const c = new AbortController();
      ctls.push(c);
      running++;
      p.ask(prompt, c.signal).then(
        (text) => {
          if (done) return;
          finish();
          resolve({ text, hedged });
        },
        (e) => {
          running--;
          if (done) return;
          if (running === 0 && (hedged || !timer)) {
            finish();
            reject(e);
          }
        },
      );
    };
    signal.addEventListener(
      "abort",
      () => {
        if (done) return;
        finish();
        reject(new Error("aborted"));
      },
      { once: true },
    );
    start();
    timer = setTimeout(() => {
      timer = undefined;
      if (done) return;
      hedged = true;
      start();
    }, p.hedgeAfterMs);
  });
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
  // per-provider deadlines (#14), from the #7 eval: Claude answered in 2-12 s; Codex is bimodal
  // (18 answers in 5-15 s, 10 past 20 s; a probe saw one at 37.5 s), so it gets 45 s and a
  // hedged second call after 15 s; Grok answered in 6-19 s with one timeout at 20 s, so 30 s.
  claude: {
    label: "claude/haiku",
    deadlineMs: 20_000,
    ask: cli(() => ["claude", "-p", "--model", "haiku", "--tools", "", "--safe-mode", "--no-session-persistence"], { stdin: true }),
  },
  codex: {
    label: "codex/gpt-6-luna",
    deadlineMs: 45_000,
    hedgeAfterMs: 15_000,
    ask: cli(
      () => ["codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-"],
      { stdin: true },
    ),
  },
  grok: {
    label: "grok/grok-4.6",
    deadlineMs: 30_000,
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
      // a mid-round check-in (#9): flip between rushing and keeping distance
      if (prompt.startsWith("Knockback check-in")) {
        const rushing = /^PLAN: target [^,]+, rush,/m.test(prompt);
        return `{"stance":"${rushing ? "distance" : "rush"}","line":"${me} switches it up.","why":"stub check-in: flip the stance"}`;
      }
      return `Sure! Here's my plan:\n\`\`\`json\n{"weapons":["rocket","bat"],"target":"weakest","stance":"rush","retaliate":"attacker","why":"stub plan: rush the weakest with rocket and bat","line":"${me} is coming for you."}\n\`\`\``;
    },
  });
  registerProvider("slow", { label: "slow/test", ask: async (_p, signal) => (await wait(600_000, signal), "{}") });
  // "tail": every other call hangs (like Codex's slow tail); hedged after 5x the stub delay
  let tailCalls = 0;
  registerProvider("tail", {
    label: "tail/test",
    hedgeAfterMs: delayMs * 5,
    ask: async (prompt, signal) => {
      const n = tailCalls++;
      await wait(n % 2 === 0 ? 600_000 : delayMs, signal);
      const me = /You are (\w+)/.exec(prompt)?.[1] ?? "someone";
      return `{"weapons":["shotgun"],"target":"nearest","stance":"rush","line":"${me} made it on the second try."}`;
    },
  });
  registerProvider("junk", { label: "junk/test", ask: async () => "I would rather not play today." });
  registerProvider("broken", {
    label: "broken/test",
    ask: async () => {
      throw new ProviderError("broken exited with status 1");
    },
  });
}
