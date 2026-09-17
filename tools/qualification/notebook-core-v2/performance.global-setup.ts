import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const browserCache = join(homedir(), "Library/Caches/ms-playwright");
const lockPath = join(browserCache, ".libre-ai-notebook-performance.lock");

type QualificationToolchain = {
  playwright: { engines: Record<string, { cacheDirectory: string }> };
};

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Notebook physical performance lock requires macOS arm64");
  }
  const toolchain = JSON.parse(
    await readFile(resolve(repositoryRoot, "toolchains/notebook-qualification.json"), "utf8"),
  ) as QualificationToolchain;
  const cachePaths = Object.values(toolchain.playwright.engines).map(({ cacheDirectory }) =>
    join(browserCache, cacheDirectory),
  );

  await mkdir(browserCache, { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("another Notebook performance qualification owns the browser cache lock");
    }
    throw error;
  }

  try {
    if (countPinnedBrowserProcesses(cachePaths) !== 0) {
      throw new Error("pinned qualification browser process is already active");
    }
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ commit: command("git", ["rev-parse", "HEAD"]), pid: process.pid })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    await rm(lockPath, { force: true, recursive: true });
    throw error;
  }

  return async () => {
    let active = countPinnedBrowserProcesses(cachePaths);
    for (let attempt = 0; attempt < 50 && active !== 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      active = countPinnedBrowserProcesses(cachePaths);
    }
    await rm(lockPath, { force: true, recursive: true });
    if (active !== 0) {
      throw new Error("pinned qualification browser process remained active after teardown");
    }
  };
}

function countPinnedBrowserProcesses(cachePaths: string[]): number {
  const processTable = execFileSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
  });
  return processTable
    .split("\n")
    .filter((line) => cachePaths.some((cachePath) => line.includes(cachePath))).length;
}

function command(executable: string, arguments_: string[]): string {
  return execFileSync(executable, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}
