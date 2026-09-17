import { describe, expect, test } from "bun:test";
import {
  closedBackupRefusal,
  decodeRecoveryAttempt,
  encodeRecoveryCode,
  freshBackupId,
  isCanonicalRecoveryCode,
} from "./material";

describe("Notebook backup product material", () => {
  test("encodes only the locked lowercase 16-byte recovery profile", () => {
    const value = Uint8Array.from({ length: 16 }, (_, index) => index);
    const encoded = encodeRecoveryCode(value);
    expect(encoded).toBe("000102030405060708090a0b0c0d0e0f");
    expect(isCanonicalRecoveryCode(encoded)).toBe(true);
    expect(isCanonicalRecoveryCode(encoded.toUpperCase())).toBe(false);
  });

  test("sends malformed and adjacent recovery lengths through component-sized attempts", () => {
    expect(decodeRecoveryAttempt("00".repeat(15)).length).toBe(15);
    expect(decodeRecoveryAttempt("00".repeat(16)).length).toBe(16);
    expect(decodeRecoveryAttempt("00".repeat(17)).length).toBe(17);
    expect(decodeRecoveryAttempt("private malformed value").length).toBe(15);
  });

  test("creates a fresh opaque backup id and wipes temporary random bytes", () => {
    const observed: Uint8Array[] = [];
    const id = freshBackupId({
      getRandomValues<T extends ArrayBufferView | null>(value: T): T {
        if (!(value instanceof Uint8Array)) throw new Error("unexpected random view");
        value.fill(0xab);
        observed.push(value);
        return value;
      },
    });
    expect(id).toBe(`urn:libre-ai:backup:${"ab".repeat(16)}`);
    expect(observed[0] && [...observed[0]]).toEqual(new Array(16).fill(0));
  });

  test("maps hostile or private failures to static errors", () => {
    const hostile = Object.create(null, {
      message: {
        get() {
          throw new Error("private getter");
        },
      },
    });
    expect(closedBackupRefusal(hostile)).toMatchObject({
      code: "internal-failure",
      message: "Backup operation failed.",
    });
    expect(closedBackupRefusal(new RangeError("private allocation"))).toMatchObject({
      code: "resource-limit-exceeded",
      message: "Backup operation unavailable.",
    });
  });
});
