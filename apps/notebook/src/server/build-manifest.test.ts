import { describe, expect, test } from "bun:test";
import { assertNotebookBuildMode } from "./build-manifest";

describe("Notebook build/runtime feature binding", () => {
  test("accepts only the build mode expected by the runtime", () => {
    const disabled = {
      backupFeature: "disabled",
      schemaVersion: "libre-ai.notebook-product-build.v1",
    };
    const enabled = {
      backupFeature: "gate-b",
      schemaVersion: "libre-ai.notebook-product-build.v1",
    };

    expect(() => assertNotebookBuildMode(disabled, false)).not.toThrow();
    expect(() => assertNotebookBuildMode(enabled, true)).not.toThrow();
    expect(() => assertNotebookBuildMode(disabled, true)).toThrow(
      "notebook.build_runtime_gate_mismatch",
    );
    expect(() => assertNotebookBuildMode(enabled, false)).toThrow(
      "notebook.build_runtime_gate_mismatch",
    );
    expect(() => assertNotebookBuildMode({}, false)).toThrow(
      "notebook.build_runtime_gate_mismatch",
    );
  });
});
