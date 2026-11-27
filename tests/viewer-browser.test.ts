import { describe, expect, test } from "bun:test";
import { parseMontageArgs } from "../scripts/montage/options";
import { OptionError, parseTeaserArgs } from "../scripts/teaser/options";
import { DEFAULT_GPU, gpuArgs, launchArgs, resolveGpu } from "../scripts/viewer-browser";

describe("Chromium GPU backend (#165)", () => {
  test("the default is SwiftShader, with no Metal or GPU flag", () => {
    expect(DEFAULT_GPU).toBe("swiftshader");
    const args = launchArgs(resolveGpu(undefined, undefined));
    expect(args).toContain("--use-angle=swiftshader");
    expect(args).toContain("--enable-unsafe-swiftshader");
    expect(args.some((a) => /metal|enable-gpu/.test(a))).toBe(false);
  });

  test("metal and default give their own flags", () => {
    expect(gpuArgs("metal")).toEqual(["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]);
    expect(gpuArgs("default")).toEqual([]);
  });

  test("the caller's own arguments come after the backend's", () => {
    expect(launchArgs("default", ["--autoplay-policy=no-user-gesture-required"])).toEqual(["--autoplay-policy=no-user-gesture-required"]);
    expect(launchArgs("swiftshader", ["--x"]).at(-1)).toBe("--x");
  });

  test("the flag wins over the environment, the environment over the default", () => {
    expect(resolveGpu("metal", "default")).toBe("metal");
    expect(resolveGpu(undefined, "Metal ")).toBe("metal");
    expect(resolveGpu(undefined, "")).toBe("swiftshader");
    expect(() => resolveGpu("vulkan", undefined)).toThrow(/--gpu must be one of swiftshader, metal, default/);
    expect(() => resolveGpu(undefined, "gpu")).toThrow(/KB_TEASER_GPU/);
  });

  test("teaser and montage take --gpu and KB_TEASER_GPU", () => {
    const now = new Date("2026-11-27T00:00:00Z");
    expect(parseTeaserArgs(["--seed", "1"], now, undefined).gpu).toBe("swiftshader");
    expect(parseTeaserArgs(["--seed", "1", "--gpu", "metal"], now, undefined).gpu).toBe("metal");
    expect(parseTeaserArgs(["--seed", "1", "--gpu=default"], now, "metal").gpu).toBe("default");
    expect(parseTeaserArgs(["--seed", "1"], now, "metal").gpu).toBe("metal");
    expect(() => parseTeaserArgs(["--seed", "1", "--gpu", "cuda"], now, undefined)).toThrow(OptionError);
    expect(parseMontageArgs(["records/"], now, undefined).gpu).toBe("swiftshader");
    expect(parseMontageArgs(["records/", "--gpu", "metal"], now, undefined).gpu).toBe("metal");
    expect(() => parseMontageArgs(["records/"], now, "x")).toThrow(OptionError);
  });
});
