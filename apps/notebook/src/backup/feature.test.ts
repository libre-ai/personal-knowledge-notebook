import { describe, expect, test } from "bun:test";
import { isNotebookBackupFeatureEnabled } from "./feature";

describe("Notebook backup feature gate", () => {
  test("enables only the exact explicit value", () => {
    expect(isNotebookBackupFeatureEnabled("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1"] as const) {
      expect(isNotebookBackupFeatureEnabled(value)).toBe(false);
    }
  });
});
