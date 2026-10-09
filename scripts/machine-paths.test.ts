import { describe, expect, test } from "bun:test";

import {
  countOccurrences,
  machinePathContext,
  machinePathNeedles,
  machinePathRemaps,
  remapConfigArgument,
  remapRustflags,
  rustflagOverrides,
  scanBytes,
} from "./machine-paths";

const encoder = new TextEncoder();
const context = machinePathContext("/srv/build/clone-a/", {}, "/srv/build-home");

describe("machinePathContext", () => {
  test("derives CARGO_HOME and RUSTUP_HOME from the home directory by default", () => {
    expect(context).toEqual({
      repositoryRoot: "/srv/build/clone-a",
      home: "/srv/build-home",
      cargoHome: "/srv/build-home/.cargo",
      rustupHome: "/srv/build-home/.rustup",
    });
  });

  test("honours CARGO_HOME and RUSTUP_HOME from the environment", () => {
    const custom = machinePathContext(
      "/w/r",
      { CARGO_HOME: "/opt/cargo", RUSTUP_HOME: "/opt/rustup" },
      "/srv/h",
    );
    expect(custom.cargoHome).toBe("/opt/cargo");
    expect(custom.rustupHome).toBe("/opt/rustup");
  });

  test("refuses a root home directory, which would remap every path", () => {
    expect(() => machinePathContext("/w/r", {}, "/")).toThrow("root home");
  });
});

describe("machinePathRemaps", () => {
  test("orders prefixes from the most general to the most specific", () => {
    // rustc applies the last matching prefix.
    expect(machinePathRemaps(context)).toEqual([
      { from: "/srv/build-home", to: "~" },
      { from: "/srv/build/clone-a", to: "." },
      { from: "/srv/build-home/.rustup", to: "/rustup" },
      { from: "/srv/build-home/.cargo", to: "/cargo" },
    ]);
  });

  test("targets do not depend on the machine", () => {
    const other = machinePathContext("/elsewhere/clone-b", {}, "/home/someone");
    expect(machinePathRemaps(other).map(({ to }) => to)).toEqual(
      machinePathRemaps(context).map(({ to }) => to),
    );
  });

  test("refuses a prefix holding '=', which rustc would split ambiguously", () => {
    expect(() => machinePathRemaps(machinePathContext("/w/a=b", {}, "/srv/h"))).toThrow("'='");
  });
});

describe("rustflags", () => {
  test("renders one --remap-path-prefix per prefix", () => {
    expect(remapRustflags([{ from: "/a", to: "~" }])).toEqual(["--remap-path-prefix=/a=~"]);
  });

  test("renders a cargo --config value as a TOML array", () => {
    expect(remapConfigArgument("build.rustflags", [{ from: '/a"b', to: "." }])).toBe(
      'build.rustflags=["--remap-path-prefix=/a\\"b=."]',
    );
  });

  test("detects every variable that would silently replace configuration rustflags", () => {
    expect(
      rustflagOverrides({
        RUSTFLAGS: "-Dwarnings",
        CARGO_ENCODED_RUSTFLAGS: "x",
        CARGO_BUILD_RUSTFLAGS: "x",
        CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "x",
        CARGO_TARGET_DIR: "/t",
        RUSTDOCFLAGS: "-Dwarnings",
        CARGO_INCREMENTAL: "",
      }),
    ).toEqual([
      "CARGO_BUILD_RUSTFLAGS",
      "CARGO_ENCODED_RUSTFLAGS",
      "CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS",
      "RUSTFLAGS",
    ]);
  });
});

describe("scan", () => {
  test("counts non-overlapping occurrences", () => {
    expect(countOccurrences(encoder.encode("aXaXa /Users/ /Users/"), "/Users/")).toBe(2);
    expect(countOccurrences(encoder.encode("aaaa"), "aa")).toBe(2);
    expect(countOccurrences(encoder.encode("clean"), "/home/")).toBe(0);
  });

  test("covers the generic prefixes and this machine's own prefixes", () => {
    expect(machinePathNeedles(context).map(({ label }) => label)).toEqual([
      "/Users/",
      "/home/",
      ".cargo/registry",
      ".rustup",
      "HOME",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "repository root",
    ]);
  });

  test("a remapped registry path is clean, an unmapped one is not", () => {
    const needles = machinePathNeedles(context);
    const remapped = scanBytes(
      [{ name: "a.wasm", bytes: encoder.encode("/cargo/registry/src/index/x/src/lib.rs") }],
      needles,
    );
    expect(remapped).toEqual({ artifacts: 1, bytes: 38, needles: 8, findings: [] });
    const leaked = scanBytes(
      [
        {
          name: "b.wasm",
          bytes: encoder.encode("/srv/build-home/.cargo/registry/src/x /srv/build/clone-a/t"),
        },
      ],
      needles,
    );
    expect(leaked.findings).toEqual([
      { artifact: "b.wasm", label: ".cargo/registry", count: 1 },
      { artifact: "b.wasm", label: "HOME", count: 1 },
      { artifact: "b.wasm", label: "CARGO_HOME", count: 1 },
      { artifact: "b.wasm", label: "repository root", count: 1 },
    ]);
  });

  test("an empty artifact or an empty artifact list is a failure, never a zero", () => {
    const needles = machinePathNeedles(context);
    expect(() => scanBytes([], needles)).toThrow("no artifact");
    expect(() => scanBytes([{ name: "e", bytes: new Uint8Array() }], needles)).toThrow("empty");
  });
});
