/**
 * Byte-exact drift gate (I-05): the vendored `schemas/` this crate embeds at
 * compile time must be identical to the contracts AUTHORITY at the revision
 * pinned in package.json/bun.lock. Run with --write to re-vendor after a pin
 * bump.
 */
import { readdirSync } from "node:fs";

const AUTHORITY = "node_modules/@libre-ai/contracts-authority/contracts/wit/notebook-core-v2";
const VENDORED = "vendored/wit/notebook-core-v2";
const write = process.argv.includes("--write");

const source = readdirSync(AUTHORITY)
  .filter((name) => name.endsWith(".wit"))
  .sort();
const vendored = readdirSync(VENDORED)
  .filter((name) => name.endsWith(".wit"))
  .sort();
const issues: string[] = [];

for (const name of source) {
  const authorityBytes = await Bun.file(`${AUTHORITY}/${name}`).bytes();
  const local = Bun.file(`${VENDORED}/${name}`);
  if (!(await local.exists())) {
    if (write) await Bun.write(`${VENDORED}/${name}`, authorityBytes);
    else issues.push(`${name}: missing from vendored schemas`);
    continue;
  }
  const localBytes = await local.bytes();
  if (Buffer.compare(Buffer.from(authorityBytes), Buffer.from(localBytes)) !== 0) {
    if (write) await Bun.write(`${VENDORED}/${name}`, authorityBytes);
    else issues.push(`${name}: vendored copy differs from the authority pin`);
  }
}
for (const name of vendored) {
  if (!source.includes(name)) issues.push(`${name}: extra file not present in the authority`);
}
if (issues.length > 0 && !write) {
  for (const issue of issues) console.error(issue);
  console.error("Vendored schemas drift from the contracts authority pin.");
  process.exit(1);
}
console.log(`Vendored schemas byte-exact against the authority pin (${source.length} files)`);
