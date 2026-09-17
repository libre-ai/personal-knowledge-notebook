# Notebook

- **Path:** `apps/notebook`
- **Owner:** Experiences / Notebook
- **Runtime:** Bun/React PWA with IndexedDB and Web Crypto
- **Tenant model:** personal local-only workspace in v1, accepted by ADR-0002

## Purpose and actors

Notebook is a private local-first block notebook that lets its owner select exactly which blocks and links enter a portable context export. The device owner is the only v1 actor; external consumers receive explicit immutable exports, never direct notebook access.

## Journeys

1. **Capture offline:** owner creates/edits linked blocks with local durable revisions and can search without network.
2. **Prepare context:** owner selects blocks, sees recursively required links/assets and explicit exclusions, then previews the exact serialized export.
3. **Share/revoke locally:** owner exports a content-addressed file, records that local export event and can mark it superseded without pretending to erase copies already shared.
4. **Backup/restore/delete:** owner produces encrypted backup, restores into a new local workspace with deterministic conflict report, or destroys workspace keys/data.

## Non-goals

- implicit ingestion, background cloud sync or server-side note storage in v1 ;
- RAG chat over the complete notebook ;
- collaborative editing, public publishing or hidden telemetry ;
- claiming remote revocation of a downloaded export ;
- transmitting blocks to build an index.

The notebook core stays strictly local-first: collaborative editing OF THE
NOTEBOOK remains a non-goal. A separate, opt-in future capability (governed by a
dedicated ADR, post-release) lets the owner export selected blocks into a
Sessions workspace for real-time co-editing with others over the sovereign
end-to-end-encrypted collaboration brick, then re-import the result as a new
local revision. The collaboration surface is external (Sessions + ciphertext-only
relay), never the notebook core; all such traffic is ciphertext, and the notebook
remains fully functional with the capability disabled.

## Domain protocol

**Commands:** `CreateWorkspace`, `CreateBlock`, `EditBlock`, `LinkBlocks`, `DeleteBlock`, `SelectContext`, `ExcludeContextBlock`, `CreateContextExport`, `MarkExportSuperseded`, `CreateEncryptedBackup`, `RestoreBackup`, `DeleteWorkspace`.

**Queries:** `GetBlock`, `SearchLocalIndex`, `GetBacklinks`, `PreviewContextExport`, `ListLocalExports`, `ValidateBackup`.

**Events:** `BlockCreated`, `BlockRevised`, `BlockLinked`, `BlockDeleted`, `ContextSelectionChanged`, `ContextExportCreated`, `ExportSuperseded`, `BackupCreated`, `BackupRestored`, `WorkspaceDeleted`.

Blocks use immutable revision records plus current head. Restore never silently overwrites: equal IDs with divergent content produce explicit conflict entries and require a new revision choice.

## Refusal matrix

| Code                                    | Refusal                                          |
| --------------------------------------- | ------------------------------------------------ |
| `notebook.workspace_locked`             | key unavailable or unlock refused                |
| `notebook.revision_stale`               | edit targets a non-current block revision        |
| `notebook.export_dependency_missing`    | selected graph references missing required block |
| `notebook.export_exclusion_conflict`    | excluded block is required by selected contract  |
| `notebook.export_preview_mismatch`      | serialized export hash differs from preview hash |
| `notebook.backup_authentication_failed` | backup AEAD verification fails                   |
| `notebook.restore_version_unsupported`  | backup contract version has no explicit adapter  |
| `notebook.remote_sync_forbidden`        | v1 request attempts server note persistence      |

Failure never uploads data or drops the previous valid local revision.

## Data

IndexedDB owns encrypted block revisions, links, local index, export metadata and settings. L'inventaire local distingue contenu chiffré, clés, index et métadonnées d'exports ; chacun est supprimé lors de `DeleteWorkspace`, tandis qu'une copie exportée hors de l'application reste sous le contrôle explicite de l'utilisateur et ne peut pas être révoquée à distance. Workspace content encryption uses a non-exportable device key where available; portable backup uses only `libre-ai.recovery-secret-code.v1` (16 local CSPRNG bytes displayed as 32 lowercase hex characters) with memory-hard KDF parameters encoded in the envelope. Passphrases and free-text recovery are not supported in v2. Retention is until explicit local deletion. Delete removes records and keys; browser/storage limitations are disclosed. No historical notebook database is migrated automatically; v1 migration input is only validated portable export/backup.

## Authentication and authorization

No server account or session is required in local-only v1. Workspace unlock is local authentication, not authorization for another service. Context exports contain no Biscuit. A future consumer imports the export under its own authorization boundary. If a native wrapper adds biometric unlock, it only releases the local key and does not create identity claims.

## Runtime boundaries

TypeScript owns block graph, UI, IndexedDB, local index, export selection and generation of fresh opaque 128-bit backup/context IDs plus fresh salt/nonce bytes. Before Context export it remaps every selected local block ID to a fresh export-scoped CSPRNG ID, rewrites roots/links, and keeps revisions and exclusions only in the local preview/receipt. Any product timestamp belongs inside the encrypted plaintext or local receipt, never in the portable payload. Notebook Core v2 is a locked Rust/WASM boundary for canonical context bytes and Argon2id/AES-256-GCM sealing/opening. Un premier host produit sous feature gate exerce cette frontière avec une fixture publique, un worker jetable, un téléchargement neutre et un staging IndexedDB chiffré ; son introduction seule ne constituait ni un producteur de sauvegarde utilisateur ni une approbation Gate B. Gate B est désormais approuvée sur `9ee3f8d`, mais aucun contenu réel ne peut l'utiliser avant un contrôle propriétaire distinct et la décision de release. No native FFI or server service is allowed in v1; sensitive bytes cross transiently, DOM and IndexedDB handles do not.

## Accessibility and degraded mode

All core journeys work offline and keyboard-only. Editor announces formatting/state without trapping focus; graph has a list/table equivalent. Export preview is readable text with included/excluded counts and warnings. Storage quota or key failure blocks mutation with export/recovery guidance and preserves previous data.

## Resource floor

Le minimum produit candidat actuellement qualifié est macOS arm64 avec 32 Gio de mémoire physique, 12 CPU logiques, les capacités navigateur WASM SIMD128/Worker/Web Crypto/IndexedDB et un quota local candidat de 512 Mio. L'ADR-0006 réduit explicitement la matrice Gate B à cette classe sans extrapoler vers les machines modestes. Les classes physiques 8 Gio et 16–24 Gio restent des observations communautaires facultatives et ne sont pas annoncées comme supportées. Les bornes, statuts et commandes sont définis dans [`notebook-resource-floor.md`](notebook-resource-floor.md) et `toolchains/notebook-resource-classes.json`.

## Contracts

- Notebook Backup v2 — `contracts/schemas/notebook-backup.v2.schema.json` ;
- Backup Seal Request v2 — `contracts/schemas/notebook-backup-seal-request.v2.schema.json` ;
- Context Document v2 — `contracts/schemas/context-document.v2.schema.json` ;
- canonicalization/backup crypto boundary — `contracts/wit/notebook-core-v2/world.wit` and `SEMANTICS.md` ;
- public test vectors — `contracts/fixtures/notebook-core-v2/golden-vectors.v1.json`.

No OpenAPI contract exists for v1 local data.

## Evidence

Unit tests cover graph closure, local-only exclusions/revisions, export-scoped ID remapping, canonical hashes and conflicts. Contract vectors cover corrupt ciphertext, unknown KDF, missing dependencies and old versions. Le host Gate B rejoue déjà sur trois moteurs le chiffrement réel d'une fixture publique, le téléchargement neutre, le staging IndexedDB, la restauration, le mauvais recovery et la reprise après page interrompue, sans persister de plaintext ou de recovery. Une campagne qualification-only candidate envoie aussi `SIGKILL` pendant seal et `SIGABRT` pendant restauration au groupe de processus de chaque navigateur, puis relance le même profil ; elle injecte séparément un quota sous le plancher et un abort transactionnel.

Une campagne storage macOS arm64 place maintenant chaque profil navigateur dans une image APFS sparse jetable et bornée à 6 Gio. Après un vrai marqueur OS `ENOSPC`, le host refuse le staging d'une enveloppe publique déterministe de 16 Mio avant de démarrer un worker ; la relance du même profil retrouve l'état produit antérieur, puis restauration et sauvegarde réussissent après suppression du filler. Cette preuve vaut pour le comportement local sous épuisement physique du filesystem, pas pour une classe matérielle ni pour la fiabilité de `navigator.storage.estimate()`.

Les tests produit complets doivent encore couvrir le modèle blocs/révisions, l'import atomique et la suppression. Conformément à l'ADR-0007, l'OOM réel du processus reste un diagnostic facultatif : Gate B exige à la place la reprise bornée après terminaison abrupte et crash dans les trois moteurs, sans autoriser l'épuisement global de l'hôte. Les classes physiques 8 Gio et 16–24 Gio restent sans preuve et hors support déclaré, mais leurs contributions ne bloquent plus Gate B. Security review proves no content network requests and no plaintext persistence/logging. Cross-browser backup vectors must round-trip.

## Work packages

1. backup/context contracts and crypto vectors — Canonical Core ;
2. local block/revision/index domain — Experiences ;
3. audited canonicalization and backup crypto WASM — Specialized Rust ;
4. PWA offline/storage/accessibility shell — Web Platform ;
5. restore/delete/privacy/browser qualification — Infrastructure and Release.

La frontière Rust reste justifiée car Argon2id mémoire dure n’est pas fournie par Web Crypto du navigateur, et la preuve Gate A montre la cohérence cryptographique. Le moteur expérimental pouvait démarrer après Gate A + décision propriétaire. Gate B est maintenant satisfaite pour la tranche fixture-only, mais toute sauvegarde utilisateur, activation, production ou release exige encore son propre contrôle propriétaire. Les vecteurs golden et la gestion des matières sensibles demeurent des gates de release.

## Release and rollback

Release requires offline create/edit/search, exact preview/export, encrypted backup/restore, conflict and deletion proof across supported browsers. Elle exige aussi une preuve réelle sur la classe minimale déclarée ; une simulation exécutée sur la machine de référence ne peut pas promouvoir une classe matérielle. Application rollback must continue reading current stored contract; a release that writes a new storage major cannot ship without a backward reader and export-first rollback plan. No rollback may resurrect a deleted key or workspace.
