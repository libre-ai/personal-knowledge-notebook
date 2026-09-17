import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderStaticDocument } from "@libre-ai/web-platform";
import { notebookDocument } from "../src/shared/document";

const root = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(root, "../..");
const dist = join(root, "dist");
const assets = join(dist, "assets");
const featureValue = process.env.NOTEBOOK_BACKUP_FEATURE_ENABLED;
if (featureValue !== undefined && featureValue !== "0" && featureValue !== "1") {
  throw new Error("notebook.backup_feature_gate_invalid");
}
const backupEnabled = featureValue === "1";

await rm(dist, { force: true, recursive: true });
await mkdir(join(dist, "static"), { recursive: true });
await mkdir(assets, { recursive: true });

const define = {
  "process.env.NODE_ENV": JSON.stringify("production"),
  "process.env.NOTEBOOK_BACKUP_FEATURE_ENABLED": JSON.stringify(backupEnabled ? "1" : "0"),
};
const clientBuild = await Bun.build({
  define,
  entrypoints: [join(root, "src/client/app.tsx")],
  minify: true,
  naming: "app.js",
  outdir: assets,
  sourcemap: "none",
  target: "browser",
});
if (!clientBuild.success) throw new Error("notebook.client_build_failed");

if (backupEnabled) {
  buildNotebookCore();
  const workerBuild = await Bun.build({
    define,
    entrypoints: [join(root, "src/backup/notebook-core-worker.ts")],
    minify: true,
    naming: "notebook-core-worker.js",
    outdir: assets,
    sourcemap: "none",
    target: "browser",
  });
  if (!workerBuild.success) throw new Error("notebook.worker_build_failed");

  const generated = join(repositoryRoot, "target/notebook-core-v2-qualification/generated");
  await Bun.write(join(assets, "notebook-core.js"), Bun.file(join(generated, "notebook-core.js")));
  await Bun.write(
    join(assets, "notebook-core.core.wasm"),
    Bun.file(join(generated, "notebook-core.core.wasm")),
  );
}

await Bun.write(
  join(assets, "tokens.css"),
  Bun.file(new URL("./tokens.css", import.meta.resolve("@libre-ai/ui/styles.css"))),
);
const foundationCss = await Bun.file(
  new URL(import.meta.resolve("@libre-ai/ui/styles.css")),
).text();
const notebookCss = await Bun.file(join(root, "src/ui/notebook.css")).text();
await Bun.write(join(assets, "styles.css"), `${foundationCss}\n${notebookCss}`);
await Bun.write(join(assets, "icon.svg"), Bun.file(join(root, "public/icon.svg")));
await Bun.write(join(dist, "static/index.html"), renderStaticDocument(notebookDocument()));
await Bun.write(
  join(dist, "manifest.webmanifest"),
  `${JSON.stringify(
    {
      background_color: "#f7f6f0",
      display: "standalone",
      icons: [{ sizes: "any", src: "/assets/icon.svg", type: "image/svg+xml" }],
      id: "/",
      lang: "fr",
      name: "Libre AI — Notebook",
      scope: "/",
      short_name: "Notebook",
      start_url: "/",
      theme_color: "#075e54",
    },
    null,
    2,
  )}\n`,
);

const outputNames = (await readdir(assets)).sort();
if (
  outputNames.some((name) => /fault|internal|trap/i.test(name)) ||
  (backupEnabled &&
    !["notebook-core-worker.js", "notebook-core.core.wasm", "notebook-core.js"].every((name) =>
      outputNames.includes(name),
    )) ||
  (!backupEnabled && outputNames.some((name) => name.startsWith("notebook-core")))
) {
  throw new Error("notebook.shipping_artifact_boundary_invalid");
}

const shippingPaths = [
  "assets/app.js",
  "assets/icon.svg",
  "assets/styles.css",
  "assets/tokens.css",
  "manifest.webmanifest",
  "static/index.html",
  ...(backupEnabled
    ? [
        "assets/notebook-core-worker.js",
        "assets/notebook-core.core.wasm",
        "assets/notebook-core.js",
      ]
    : []),
].sort();
const shippingFiles = Object.fromEntries(
  await Promise.all(
    shippingPaths.map(async (path) => [
      path,
      {
        bytes: Bun.file(join(dist, path)).size,
        sha256: await sha256File(join(dist, path)),
      },
    ]),
  ),
);
const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: "pipe",
});
if (commitResult.status !== 0 || !/^[a-f0-9]{40}\n?$/.test(commitResult.stdout ?? "")) {
  throw new Error("notebook.commit_provenance_unavailable");
}
let coreProvenance: Record<string, unknown> | null = null;
if (backupEnabled) {
  const qualificationManifestPath = join(
    repositoryRoot,
    "target/notebook-core-v2-qualification/manifest.json",
  );
  const qualificationManifestBytes = await Bun.file(qualificationManifestPath).arrayBuffer();
  const qualificationManifest = JSON.parse(
    new TextDecoder().decode(qualificationManifestBytes),
  ) as {
    generated?: Record<string, { bytes?: number; sha256?: string }>;
    schemaVersion?: string;
  };
  const generatedCore = qualificationManifest.generated?.["notebook-core.core.wasm"];
  const generatedBindings = qualificationManifest.generated?.["notebook-core.js"];
  if (
    qualificationManifest.schemaVersion !== "libre-ai.notebook-core-v2-qualification-manifest.v1" ||
    generatedCore?.sha256 !== shippingFiles["assets/notebook-core.core.wasm"]?.sha256 ||
    generatedBindings?.sha256 !== shippingFiles["assets/notebook-core.js"]?.sha256
  ) {
    throw new Error("notebook.core_provenance_mismatch");
  }
  coreProvenance = {
    generatedBindings,
    generatedCore,
    qualificationManifestSha256: new Bun.CryptoHasher("sha256")
      .update(qualificationManifestBytes)
      .digest("hex"),
  };
}
await Bun.write(
  join(dist, "notebook-build-manifest.json"),
  `${JSON.stringify(
    {
      backupFeature: backupEnabled ? "gate-b" : "disabled",
      commit: commitResult.stdout.trim(),
      coreProvenance,
      schemaVersion: "libre-ai.notebook-product-build.v1",
      shippingFiles,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Built Notebook product host with backup feature ${backupEnabled ? "gate-b" : "disabled"}`,
);

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

function buildNotebookCore(): void {
  const node = process.env.NOTEBOOK_QUALIFICATION_NODE;
  if (!node) throw new Error("notebook.pinned_node_required");
  const result = spawnSync(
    node,
    [
      "--no-warnings=MODULE_TYPELESS_PACKAGE_JSON",
      join(repositoryRoot, "tools/qualification/notebook-core-v2/build.ts"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error("notebook.core_build_failed");
  }
}
