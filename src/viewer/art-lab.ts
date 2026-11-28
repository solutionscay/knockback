import { Application, Text } from "pixi.js";
import type { PlushInput } from "./plush-bot";

export const idlePose: Readonly<PlushInput> = { dt: 1 / 12, alive: true, air: false, stunned: false, vx: 0, vy: 0, weapon: "fist", aim: 0, swingT: 0, recoil: 0, hitT: 0, celebrate: false, facing: 1 };

export async function labCanvas(width: number, height: number) {
  const app = new Application();
  await app.init({ background: 0x141a2e, width, height, antialias: true, resolution: 1, preference: "webgl" });
  document.body.appendChild(app.canvas);

  function label(text: string, x: number, y: number, size = 13) {
    const t = new Text({ text, style: { fill: 0xb8c2e0, fontSize: size, fontWeight: "700", fontFamily: "system-ui" } });
    t.position.set(x, y);
    app.stage.addChild(t);
  }

  return { app, label };
}
