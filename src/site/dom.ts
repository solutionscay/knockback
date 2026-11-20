/**
 * Small DOM helpers for the site pages. `html` escapes every interpolated value unless it is wrapped in raw()
 * (only for markup the page builds itself, like the bot SVGs).
 */
export class Raw {
  constructor(readonly s: string) {}
  toString() {
    return this.s;
  }
}
export const raw = (s: string) => new Raw(s);
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function part(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let s = strings[0]!;
  vals.forEach((v, i) => (s += part(v) + strings[i + 1]!));
  return new Raw(s);
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export function mount(el: Element | null, h: Raw) {
  if (el) el.innerHTML = h.s;
}

export async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: (await r.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    t.setAttribute("role", "status");
    document.body.append(t);
  }
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t!.classList.remove("on"), 1600);
}

/** Copy buttons: <button class="copy" data-copy="#id or text-source selector">. One listener for the page. */
export function wireCopy(root: ParentNode = document) {
  root.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy]");
    if (!b) return;
    const src = $(b.dataset.copy!);
    const text = src instanceof HTMLInputElement ? src.value : (src?.textContent ?? "");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    b.classList.add("ok");
    const was = b.textContent;
    b.textContent = "Copied";
    setTimeout(() => {
      b.classList.remove("ok");
      b.textContent = was;
    }, 1200);
  });
}

/** Repeat `fn` every `ms` while the page is shown; returns a stop function. */
export function every(ms: number, fn: () => unknown): () => void {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    if (!document.hidden) await fn();
    if (!stopped) setTimeout(run, ms);
  };
  void run();
  return () => (stopped = true);
}
