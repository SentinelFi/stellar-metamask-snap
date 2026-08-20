# Audits

Third-party security audit reports for the Stellar Soroban Snap will be published here.

A third-party audit is a prerequisite for allowlisting on stable MetaMask (the snap uses the audit-gated `snap_getBip32Entropy` permission). See [docs/THREAT-MODEL.md](../docs/THREAT-MODEL.md) for the threat model provided to auditors.

Automated security-scan reports (e.g. Snapper) are kept separately under [scans/](scans/): those are tool output, not a third-party audit.

## Dependency advisory gates

`known-advisories.json` is the allowlist read by two CI gates over the snap's transitive production dependencies:

- `scripts/check-snap-graph-advisories.mjs` computes the snap workspace's exact, lockfile-resolved production closure from Yarn's own resolution (`yarn info --recursive --virtuals`, following only the manifest's `dependencies`), posts the exact `{ name: [versions] }` map to the npm bulk advisory endpoint, and fails on any advisory in a module the allowlist has not dispositioned. It first checks that the endpoint still reports advisories for a version known to carry one, so an empty answer cannot pass by accident.
- `scripts/check-known-advisories.mjs` reads `yarn npm audit --recursive --json` for the snap workspace and additionally proves, by searching the built bundle for string markers, that every package the allowlist calls absent really is absent from the artifact that ships.

A caveat about the second gate, recorded here so nobody reads its output as exact: the vendored Yarn 3 keys its audit map by package name across every workspace, so when the snap and the site resolve different versions of one package (axios 1.18.0 through the Stellar SDK versus axios 1.12.1 through gatsby, at the time of writing) it reports one version for both. The versions in that report may therefore belong to another workspace. The first gate exists because of this; the allowlist is keyed by module rather than by version or advisory for the same reason.
