/**
 * Sound controls in the corner HUD: a mute button and a volume slider, remembered per browser (localStorage).
 * Until the first click or key press the button says so: browsers keep audio off until then.
 */
import type { AudioEngine } from "./engine";

const CSS = `
#sound { display: inline-flex; align-items: center; gap: calc(0.6 * var(--u, 1vh)); margin-right: calc(0.8 * var(--u, 1vh)); }
#sound button { min-width: 7.5em; }
#sound input[type=range] { width: calc(9 * var(--u, 1vh)); min-width: 70px; accent-color: #ffd27a; }
#sound.locked button { color: #ffd27a; }
`;

export function mountSoundControls(engine: AudioEngine, parent: HTMLElement | null) {
  if (!parent) return;
  if (!document.getElementById("sound-css")) {
    const st = document.createElement("style");
    st.id = "sound-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const box = document.createElement("span");
  box.id = "sound";
  const btn = document.createElement("button");
  btn.type = "button";
  const vol = document.createElement("input");
  vol.type = "range";
  vol.min = "0";
  vol.max = "100";
  vol.step = "1";
  vol.title = "Volume";
  vol.setAttribute("aria-label", "Volume");
  box.append(btn, vol);
  parent.prepend(box);
  const render = () => {
    const s = engine.settings;
    box.className = engine.unlocked ? "" : "locked";
    btn.textContent = !engine.unlocked ? "🔈 tap for sound" : s.muted || s.volume === 0 ? "🔇 sound off" : "🔊 sound on";
    btn.title = s.muted ? "Unmute" : "Mute";
    btn.setAttribute("aria-pressed", String(s.muted));
    vol.value = String(Math.round(s.volume * 100));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // the first click anywhere unlocks audio (engine.unlockOn); on this button that click means "sound on"
    if (!engine.unlocked || Date.now() - engine.unlockedAt < 800) {
      engine.unlock();
      engine.setSettings({ muted: false });
    } else engine.setSettings({ muted: !engine.settings.muted });
  });
  vol.addEventListener("input", (e) => {
    e.stopPropagation();
    engine.unlock();
    engine.setSettings({ volume: Number(vol.value) / 100, muted: false });
  });
  vol.addEventListener("pointerdown", (e) => e.stopPropagation());
  engine.onChange = render;
  render();
}
