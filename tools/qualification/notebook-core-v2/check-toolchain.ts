import { homedir } from "node:os";
import { join } from "node:path";

interface Asset {
  archiveName: string;
  archiveSha256: string;
  executableRelativePath: string;
  executableSha256: string;
}

interface Engine {
  descriptor: string;
  revision: string;
  browserVersion: string;
  cacheDirectory: string;
  archiveName: string;
  archiveSha256: string;
  executables: Array<{ path: string; sha256: string }>;
}

interface QualificationToolchain {
  node: { version: string; platforms: Record<string, Asset> };
  playwright: {
    version: string;
    browsersJsonSha256: string;
    evidencePlatform: string;
    engines: Record<string, Engine>;
  };
}

const root = process.cwd();
const manifest = (await Bun.file(
  join(root, "toolchains/notebook-qualification.json"),
).json()) as QualificationToolchain;
const platform = `${process.platform}-${process.arch}`;
const failures: string[] = [];

const nodeAsset = manifest.node.platforms[platform];
if (!nodeAsset) {
  failures.push(`Node qualification asset is not pinned for ${platform}`);
} else {
  const nodeCommand = process.env.NOTEBOOK_QUALIFICATION_NODE ?? "node";
  const nodeResult = Bun.spawnSync({
    cmd: [
      nodeCommand,
      "-p",
      "JSON.stringify({version:process.versions.node,path:process.execPath})",
    ],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (nodeResult.exitCode !== 0) {
    failures.push("Pinned Node executable is unavailable");
  } else {
    let node: { version: string; path: string } | undefined;
    try {
      node = JSON.parse(nodeResult.stdout.toString()) as { version: string; path: string };
    } catch {
      failures.push("Pinned Node executable returned invalid provenance");
    }
    if (node?.version !== manifest.node.version)
      failures.push("Node version does not match manifest");
    if (node && (await sha256File(node.path)) !== nodeAsset.executableSha256) {
      failures.push("Node executable checksum does not match manifest");
    }
  }
}

const playwrightManifest = (await Bun.file(
  join(root, "node_modules/@playwright/test/package.json"),
).json()) as { version?: string };
if (playwrightManifest.version !== manifest.playwright.version) {
  failures.push("Playwright package version does not match manifest");
}

const browserManifestPaths: string[] = [];
const browserManifestGlob = new Bun.Glob(
  "node_modules/.bun/playwright-core@*/node_modules/playwright-core/browsers.json",
);
for await (const path of browserManifestGlob.scan({ cwd: root, onlyFiles: true })) {
  browserManifestPaths.push(path);
}
if (browserManifestPaths.length !== 1) {
  failures.push("Expected exactly one installed Playwright browser manifest");
} else {
  const browsersPath = join(root, browserManifestPaths[0] ?? "");
  if ((await sha256File(browsersPath)) !== manifest.playwright.browsersJsonSha256) {
    failures.push("Playwright browser manifest checksum does not match");
  }
  const browsers = (await Bun.file(browsersPath).json()) as {
    browsers?: Array<{ name?: string; revision?: string; browserVersion?: string }>;
  };
  for (const [name, engine] of Object.entries(manifest.playwright.engines)) {
    const descriptor = browsers.browsers?.find((entry) => entry.name === engine.descriptor);
    if (
      descriptor?.revision !== engine.revision ||
      descriptor.browserVersion !== engine.browserVersion
    ) {
      failures.push(`${name}: Playwright descriptor does not match manifest`);
    }
  }
}

if (platform !== manifest.playwright.evidencePlatform) {
  failures.push(`Browser evidence is not pinned for ${platform}`);
} else {
  const browserRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), "Library/Caches/ms-playwright");
  for (const [name, engine] of Object.entries(manifest.playwright.engines)) {
    for (const executable of engine.executables) {
      const path = join(browserRoot, engine.cacheDirectory, executable.path);
      if (!(await Bun.file(path).exists())) {
        failures.push(`${name}: pinned executable is missing`);
      } else if ((await sha256File(path)) !== executable.sha256) {
        failures.push(`${name}: executable checksum does not match manifest`);
      }
    }
  }
}

const archiveDirectory = process.env.NOTEBOOK_QUALIFICATION_ARCHIVE_DIR;
if (process.env.NOTEBOOK_QUALIFICATION_REQUIRE_ARCHIVES === "1" && !archiveDirectory) {
  failures.push("Qualification archive directory is required for this evidence run");
}
if (archiveDirectory) {
  if (nodeAsset) await verifyArchive("node", nodeAsset.archiveName, nodeAsset.archiveSha256);
  for (const [name, engine] of Object.entries(manifest.playwright.engines)) {
    await verifyArchive(name, engine.archiveName, engine.archiveSha256);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(
  `Notebook qualification toolchain verified: Node ${manifest.node.version}, Playwright ${manifest.playwright.version}, ${Object.keys(manifest.playwright.engines).join("/")}`,
);

async function verifyArchive(name: string, fileName: string, expected: string): Promise<void> {
  if (!archiveDirectory) return;
  const path = join(archiveDirectory, fileName);
  if (!(await Bun.file(path).exists())) {
    failures.push(`${name}: pinned archive is missing`);
  } else if ((await sha256File(path)) !== expected) {
    failures.push(`${name}: archive checksum does not match manifest`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}
