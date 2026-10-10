import { expect } from "@playwright/test";

// Directive-level parsing instead of substring checks: a substring match accepts
// `script-src 'self' 'unsafe-inline'` as containing "script-src 'self'", and
// would not notice a second script-src directive or a script-src-elem override.
export function parseContentSecurityPolicy(header: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const rawDirective of header.split(";")) {
    const [name, ...values] = rawDirective.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    expect(directives.has(key), `duplicate CSP directive ${key}`).toBe(false);
    directives.set(key, values);
  }
  return directives;
}

// The only script source beyond 'self' is WASM compilation, added by the
// Gate B host (src/server/handler.ts). Anything else re-opens script injection.
const SCRIPT_SOURCES = ["'self'", "'wasm-unsafe-eval'"];

export function assertStrictContentSecurityPolicy(header: string | undefined): void {
  expect(header, "Content-Security-Policy header is served").toBeTruthy();
  const directives = parseContentSecurityPolicy(header ?? "");

  expect(directives.get("default-src")).toEqual(["'self'"]);
  expect(directives.get("script-src")).toEqual(SCRIPT_SOURCES);
  for (const fallbackBypass of ["script-src-elem", "script-src-attr"]) {
    expect(directives.has(fallbackBypass), `${fallbackBypass} must not override script-src`).toBe(
      false,
    );
  }
  expect(directives.get("object-src")).toEqual(["'none'"]);
  expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  expect(directives.get("base-uri")).toEqual(["'none'"]);

  for (const [name, values] of directives) {
    expect(values, `${name} must not allow inline code`).not.toContain("'unsafe-inline'");
    expect(values, `${name} must not allow string evaluation`).not.toContain("'unsafe-eval'");
  }
}
