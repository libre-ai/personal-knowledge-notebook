/**
 * p02-job-v1, validated against the authority's schema vendored byte-exact
 * at a pinned commit (vendored/contracts/p02-job-v1/provenance.json). The
 * Rust worker validates the same documents against the same vectors.
 */
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const VENDORED = resolve(import.meta.dir, "../../../vendored/contracts/p02-job-v1");

const ajv = new Ajv2020({ allErrors: false, strict: true });
addFormats(ajv);
ajv.addSchema(await Bun.file(`${VENDORED}/common.v1.schema.json`).json());
const validate = ajv.compile(await Bun.file(`${VENDORED}/p02-job.v1.schema.json`).json());

export type Validation = { ok: true } | { ok: false; paths: string[] };

/** Validate a p02-job-v1 document. Error paths only, never values. */
export function validateJobDocument(document: unknown): Validation {
  if (validate(document)) return { ok: true };
  const paths = (validate.errors ?? []).map((error) => error.instancePath || "/").slice(0, 20);
  return { ok: false, paths };
}
