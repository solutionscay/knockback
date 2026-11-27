/**
 * The one Chromium launcher of the render and capture scripts (teaser, montage, record, levels, fps, ...), with a
 * selectable GPU backend (docs/video.md#gpu-backend). Pure parts tested in tests/viewer-browser.test.ts.
 *
 *   swiftshader  (default) ANGLE on SwiftShader: WebGL on the CPU. The same pixels on every machine, also with no GPU
 *                (a Linux box, a container), and it keeps the development Mac's GPU free (its rule: CPU only).
 *   metal        ANGLE on Metal: the Mac GPU. Faster capture on Apple Silicon, only when asked for.
 *   default      no GPU flags: Chromium picks.
 */
import { chromium, type Browser } from "playwright";

export const GPU_BACKENDS = ["swiftshader", "metal", "default"] as const;
export type GpuBackend = (typeof GPU_BACKENDS)[number];
export const DEFAULT_GPU: GpuBackend = "swiftshader";
/** the environment variable that picks the backend when no --gpu flag does */
export const GPU_ENV = "KB_TEASER_GPU";

/** The Chromium arguments of a backend. */
export function gpuArgs(gpu: GpuBackend): string[] {
  switch (gpu) {
    case "swiftshader":
      return ["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--disable-gpu"];
    case "metal":
      return ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"];
    case "default":
      return [];
  }
}

/** The backend from a --gpu flag, else the environment variable, else the default. Throws on an unknown name. */
export function resolveGpu(flag?: string, env: string | undefined = process.env[GPU_ENV]): GpuBackend {
  const [name, from] = flag !== undefined ? [flag, "--gpu"] : env ? [env, GPU_ENV] : [DEFAULT_GPU, "default"];
  const v = name.trim().toLowerCase();
  if (!(GPU_BACKENDS as readonly string[]).includes(v)) throw new Error(`${from} must be one of ${GPU_BACKENDS.join(", ")} (got "${name}")`);
  return v as GpuBackend;
}

/** All launch arguments: the backend's, then the caller's own (e.g. the autoplay policy). */
export function launchArgs(gpu: GpuBackend, extra: readonly string[] = []): string[] {
  return [...gpuArgs(gpu), ...extra];
}

/** The WebGL renderer string a page of this browser sees (e.g. "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...)"). */
export async function webglRenderer(browser: Browser): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
      if (!gl) return "no WebGL";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    });
  } finally {
    await page.close();
  }
}

export function launchViewerBrowser(gpu: GpuBackend = resolveGpu(), extra: readonly string[] = []): Promise<Browser> {
  return chromium.launch({ args: launchArgs(gpu, extra) });
}
