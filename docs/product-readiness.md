# Product readiness

This cockpit duplicated the state authority and drifted out of sync with it (last dated 2026-07-14, describing a pre-graft "Specification / discovery" state the repository had already moved past). It is retired in favor of the single state authority.

Readiness state — maturity, exposure, confidence, phases, exit criteria and evidence — lives in [`project.v1.yaml`](../project.v1.yaml) (ADR-0020 §6.2). The generated summary in [`README.md`](../README.md#état-du-projet) is rendered from that card and fails CI if it ever diverges. [`ROADMAP.md`](../ROADMAP.md) expands the current phase in prose.
