import { expect, test } from "bun:test";
import { liveStreamUrl } from "../src/viewer/live-url";

test.each(["live", "live&match="])("%s keeps the server default live selection", (query) => {
  expect(liveStreamUrl(new URLSearchParams(query))).toBe("/api/live");
});

test("an explicit live match reaches the SSE endpoint without other viewer options", () => {
  const url = new URL(liveStreamUrl(new URLSearchParams("live&match=m_1234abcd&seed=42&capture")), "http://kb.test");
  expect(url.pathname).toBe("/api/live");
  expect([...url.searchParams]).toEqual([["match", "m_1234abcd"]]);
});

test("match selection is encoded as one value, not additional parameters or a URL", () => {
  const selection = "m_x&match=m_other#fragment /?x=1";
  const url = new URL(liveStreamUrl(new URLSearchParams({ live: "", match: selection })), "http://kb.test");
  expect(url.origin).toBe("http://kb.test");
  expect([...url.searchParams]).toEqual([["match", selection]]);
  expect(url.hash).toBe("");
});
