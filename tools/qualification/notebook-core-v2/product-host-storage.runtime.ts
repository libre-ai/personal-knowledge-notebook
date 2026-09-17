import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const STORAGE_RUNTIME_ROOT = resolve("target/notebook-product-host-storage/runtime");
const STORAGE_LOCK_PATH = resolve("target/notebook-product-host-storage.lock");
const BROWSERS = ["chromium", "firefox", "webkit"] as const;

export async function prepareStorageRuntime(): Promise<void> {
  await mkdir(dirname(STORAGE_LOCK_PATH), { recursive: true });
  await acquireLock();
  try {
    await detachQualificationVolumes();
    await rm(STORAGE_RUNTIME_ROOT, { force: true, recursive: true });
    await mkdir(STORAGE_RUNTIME_ROOT, { recursive: true });
  } catch (error) {
    if (!qualificationVolumeIsMounted()) {
      await unlink(STORAGE_LOCK_PATH).catch(() => undefined);
    }
    throw error;
  }
}

export async function cleanupStorageRuntime(): Promise<void> {
  const owner = Number.parseInt(await readFile(STORAGE_LOCK_PATH, "utf8"), 10);
  if (owner !== process.pid) {
    throw new Error("refusing to clean a storage qualification owned by another process");
  }
  await detachQualificationVolumes();
  await rm(STORAGE_RUNTIME_ROOT, { force: true, recursive: true });
  await unlink(STORAGE_LOCK_PATH);
}

async function acquireLock(): Promise<void> {
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(STORAGE_LOCK_PATH, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number.parseInt(await readFile(STORAGE_LOCK_PATH, "utf8"), 10);
    if (Number.isSafeInteger(owner) && owner > 0 && processIsAlive(owner)) {
      throw new Error("another product-host storage qualification is already running");
    }
    throw new Error(
      `stale storage qualification lock: remove ${STORAGE_LOCK_PATH} only after detaching its APFS image`,
    );
  }
  try {
    await lock.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    await unlink(STORAGE_LOCK_PATH).catch(() => undefined);
    throw error;
  } finally {
    await lock.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function detachQualificationVolumes(): Promise<void> {
  for (const browserName of BROWSERS) {
    const mountPoint = join(STORAGE_RUNTIME_ROOT, browserName, "mount");
    try {
      execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mountPoint], {
        stdio: "ignore",
      });
    } catch {
      // An absent mountpoint is the normal clean state.
    }
  }
  if (qualificationVolumeIsMounted()) {
    throw new Error("a bounded qualification APFS image could not be detached");
  }
}

function qualificationVolumeIsMounted(): boolean {
  try {
    const output = execFileSync("/usr/bin/hdiutil", ["info"], { encoding: "utf8" });
    return output.includes("target/notebook-product-host-storage/runtime");
  } catch {
    return true;
  }
}
