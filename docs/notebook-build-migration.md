# Notebook local build evidence

The imported browser test pinned the historical core SHA-256 `be423962e3a889e792a69a1ab60b978bcbf5ae1102db74a68c70a9a1c65e5942`. That attestation is historical and does not qualify this migrated build. The first local build produced `7b113527cb1507ce569fb92fb56d661c302cbfb663e3d164fbe439149ed27280`. The precise compiler/path contribution to this difference has not been isolated; binary equivalence is not asserted.

The browser test now compares actual HTTP bytes with the shipping manifest and its hashed qualification manifest. The latter records current source and recipe hashes, pinned Node identity, observed Rust version, closed WIT and zero core imports. Existing successful restoration, authentication refusals, invalid-envelope refusals, interrupted staging and secret-clearing assertions remain unchanged. These are local tests, not deployment or universal runtime qualification.
