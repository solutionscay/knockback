/** Sound is on by default on every page: a mute does not carry over; only the volume is remembered. */
import { expect, test } from "bun:test";
import { loadSettings, saveSettings } from "../src/viewer/audio/engine";

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test("a muted page does not leave the next page muted; the volume carries over", () => {
  const s = store();
  saveSettings({ muted: true, volume: 0.35 }, s);
  expect(loadSettings(s)).toEqual({ muted: false, volume: 0.35 });
  // a stored mute from an older page is ignored too
  s.setItem("knockback.sound", JSON.stringify({ muted: true, volume: 0.5 }));
  expect(loadSettings(s)).toEqual({ muted: false, volume: 0.5 });
});

test("nothing stored: sound on at the default volume", () => {
  expect(loadSettings(store())).toEqual({ muted: false, volume: 0.7 });
});
