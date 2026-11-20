import { chromium } from "playwright";

export function launchViewerBrowser() {
  return chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
}
