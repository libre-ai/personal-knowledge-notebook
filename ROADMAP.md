# Roadmap

This is a contribution map, not a startup roadmap or a delivery promise. It shows where help is useful while keeping scope explicit.

The state authority is [`project.v1.yaml`](project.v1.yaml) (ADR-0020 §6.2) — phases, exit criteria and evidence live there; this page only expands on them in prose. If this page and the card ever disagree, the card wins.

## Now — engine (L1-L3) and controlled export (L4-L5)

- wire the block domain (`apps/notebook/src/domain/block.ts`) to real IndexedDB persistence with a non-test caller, proven by an e2e create→edit→link→search→delete (L1);
- ship a minimal capture/edit screen — today the only screen in the app is the Gate B backup/restore host (L2);
- mount local search (`SearchLocalIndex`) in the UI (L3);
- implement `SelectContext` / `CreateContextExport` / `PreviewContextExport` against a real block — today these are documented in `docs/apps/notebook.md` with no implementation (L4);
- integrate the notebook-core WASM component into that real export path, with `crates/notebook-core/tests/golden.rs` verified on that path, not only the fixture-only Gate B host (L5).

## Next — real-data activation (L6)

- activate `NOTEBOOK_BACKUP_FEATURE_ENABLED` only once L1-L5 land;
- publish a dogfooding report on real content, not the public Gate B fixture.

## Later — parity T1 (L7) and beyond

- close the 6 T1 core-parity items one by one (unlinked-mentions detection, relationship-graph visualization, custom attributes/tags, advanced search filters, context text/HTML export, undo/redo with a local limit), each closure backed by a freshly dated PARITY audit measuring delivered code;
- the 42-item ABSENT-T1 set and the historical 71-of-143 coverage figure are the T2 horizon, deferred past v1 (`project.v1.yaml` promotion_criteria);
- sync or multi-device usage only when encryption, conflict, and authorization are proven — never before, per the non-goals in `project.v1.yaml`;
- knowledge-graph and mapping-point visualization over notes, code maps, and linked context (need captured in the ecosystem shared spec `codebase-memory-mcp-decomposition.md`).
