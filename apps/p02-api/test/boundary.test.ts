import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// S0.5 boundary: the API never fetches a URL and never evaluates a rule —
// the worker does both. No outbound network primitive may appear in its
// source (the root check also runs the fleet's check-no-transmission on it).
const SOURCE = resolve(import.meta.dir, "../src");
const FORBIDDEN = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bBun\.connect\b/,
  /\bnode:(?:http|https|net|tls|dgram|dns)\b/,
  /\bEventSource\b/,
];

test("the API source carries no outbound network primitive", async () => {
  const files = readdirSync(SOURCE).filter((name) => name.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(3);
  const findings: string[] = [];
  for (const file of files) {
    const text = await Bun.file(join(SOURCE, file)).text();
    for (const pattern of FORBIDDEN) {
      // `fetch:` is the inbound handler option of Bun.serve, not a call.
      const stripped = text.replace(/\bfetch\s*:\s*/g, "");
      if (pattern.test(stripped)) findings.push(`${file}: ${pattern}`);
    }
  }
  expect(findings).toEqual([]);
});
