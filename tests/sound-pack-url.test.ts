/** The private sample pack (#12, #166): the viewer asks for a manifest only when ?sounds= names one. */
import { expect, test } from "bun:test";
import { packManifestUrl } from "../src/viewer/audio/engine";

test("no ?sounds=: no manifest request (the site serves no pack, so a default URL is a 404 in every console)", () => {
  expect(packManifestUrl(null)).toBeNull();
  expect(packManifestUrl("")).toBeNull();
  expect(packManifestUrl("off")).toBeNull();
});

test("?sounds= with a same-site path or an https URL to a .json file", () => {
  expect(packManifestUrl("/sounds/manifest.json")).toBe("/sounds/manifest.json");
  expect(packManifestUrl("https://cdn.example.com:8443/pack/m.json")).toBe("https://cdn.example.com:8443/pack/m.json");
});

test("anything else is ignored", () => {
  for (const bad of ["http://example.com/m.json", "//example.com/m.json", "/sounds/pack.ogg", "javascript:alert(1)//.json", "/a b.json"]) expect(packManifestUrl(bad)).toBeNull();
});
