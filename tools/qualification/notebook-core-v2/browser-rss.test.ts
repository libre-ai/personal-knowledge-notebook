import { describe, expect, test } from "bun:test";

import { sumPinnedBrowserCacheRss } from "./browser-rss";

const CACHE = "/qualification-cache/firefox-1532";

describe("Notebook browser RSS process selection", () => {
  test("sums every process from the exclusively locked pinned cache", () => {
    const table = [
      `1000 ${CACHE}/firefox --headless`,
      `250 ${CACHE}/plugin-container --childID 1`,
      `9000 ${CACHE}/Playwright.app/Contents/MacOS/Playwright`,
      "7000 /another-cache/firefox --headless",
      "malformed row",
    ].join("\n");

    expect(sumPinnedBrowserCacheRss(table, CACHE)).toBe(10_250 * 1024);
  });

  test("fails closed for an invalid cache path", () => {
    expect(() => sumPinnedBrowserCacheRss("", "")).toThrow("invalid pinned browser cache path");
  });
});
