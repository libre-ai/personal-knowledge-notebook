# personal-knowledge-notebook Canonical Agent Rules

## Purpose

Reserved couche-1 product home for Libre AI Personal Knowledge Notebook:
capture, organize and find notes again while choosing deliberately what is
shared or exported.
Doctrine lives upstream: https://raw.githubusercontent.com/libre-ai/project-governance/HEAD/AGENTS.md

## Domain doctrine

- Locality, confidentiality and recoverability are claimed only once storage,
  deletion and network behavior are measured; tests use synthetic notes.
- The encrypted backup is never announced from the build without backup.
- `project.v1.yaml` is the authority on project state and admission
  criteria; the README "Project status" section is generated from it —
  never edit that section by hand.
- Recovered code (`apps/notebook`, `crates/notebook-core`) is not product
  qualification.
- Contract shapes are canonical in `libre-ai/schemas-and-contracts`, consumed
  pinned, never redefined here.

## Commands

- Prepare the pinned composition (target `personal-knowledge-notebook`):
  https://raw.githubusercontent.com/libre-ai/project-governance/HEAD/docs/LOCAL-COMPOSITION.md
- `bun run check` from this repository's root in the composition.
- Native engine: `cargo fetch --locked`, then `cargo test --locked --offline`.
- Build: `bun run --cwd apps/notebook build`; the backup build and browser
  suite need the pinned Node of `toolchains/notebook-qualification.json`.

## Working here

- Security > quality > performance > completeness, in that order on conflict.
- Check real state before editing: `git status --short` and the check above;
  never hide a red test, and a Linux WebKit refusal is not a WebKit pass.
- English for code, comments and this file.
- Never commit a machine-local absolute filesystem path, a secret or a
  personal identifier.
