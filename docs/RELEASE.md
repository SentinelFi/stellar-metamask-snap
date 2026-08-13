# Release process

> How to cut a release of `stellar-soroban-snap` and `stellar-soroban-snap-connector`. Changelog: [CHANGELOG.md](../CHANGELOG.md). Pre-launch context: [PHASE-5.md](PHASE-5.md).

The two packages are versioned and released **together**. The connector pins the exact snap version it installs, so a snap release with no connector release would leave dapps installing the previous, differently-audited snap.

Every published version is also a **Directory event**: allowlisting is version-pinned, so each release needs a fresh Snaps Directory submission before users on the allowlist see it. Budget for that review when planning a release, and prefer batching changes over shipping frequent patch versions.

## The version lives in four files

A bump has to touch all four. They are checked in CI (`yarn check:versions`), which fails the build on a mismatch:

| File                               | Field                  |
| ---------------------------------- | ---------------------- |
| `packages/snap/package.json`       | `version`              |
| `packages/snap/snap.manifest.json` | `version`              |
| `packages/connector/package.json`  | `version`              |
| `packages/connector/src/snap.ts`   | `DEFAULT_SNAP_VERSION` |

The last one is the easy one to miss: it is a hardcoded constant, not read from `package.json`, because the snap bundle must not depend on package metadata at runtime. It is what dapps get when they do not pass an explicit version.

A fifth location is **not** part of the bump but must be updated before a production site build: `GATSBY_SNAP_VERSION` in `packages/site/.env.production` (see `.env.production.dist`). A production build is refused unless `GATSBY_SNAP_ORIGIN` is exactly the audited `npm:` snap ID and `GATSBY_SNAP_VERSION` is an exact release version; after the build, `gatsby-node.js` also verifies that both actually reached the emitted JavaScript. The `GATSBY_` prefix is Gatsby's documented contract for reaching browser code, and is required.

## Versioning

Semantic versioning, from the perspective of a dapp using the RPC surface and of a user whose accounts and state persist:

- **Major**: a removed or behaviourally changed RPC method, a state schema migration that drops data, or a change in derived addresses. The last would be catastrophic and should never happen: SEP-0005 derivation is fixed.
- **Minor**: a new RPC method, a new operation type the dialogs can render, new permissions in the manifest. Manifest permission changes force users to re-consent on update, so call them out in the changelog.
- **Patch**: fixes and display changes that add no capability.

Any release that changes `snap.manifest.json` `initialPermissions` deserves an explicit changelog note, because the update prompt will ask users to approve the new permission.

## Checklist

Run from a clean tree on `main`, with CI green.

1. **Pick the version** and confirm it against the rules above.
2. **Update the changelog.** Move `[Unreleased]` entries under a new `[X.Y.Z]` heading with the date, add a fresh empty `[Unreleased]`, and update the link definitions at the bottom. Record the audited commit for any release that has been through an audit.
3. **Bump all four version locations**, then verify:

   ```bash
   yarn check:versions
   ```

4. **Build and verify the bundle.** The manifest shasum must match the bundle actually being published:

   ```bash
   yarn workspace stellar-soroban-snap build
   git diff --exit-code packages/snap/snap.manifest.json
   ```

   A non-empty diff means the committed manifest was stale; commit the regenerated one. Builds are reproducible on the supported runtime (Node 22 only, see [PHASE-5.md](PHASE-5.md)), so the shasum a reviewer computes will match.

5. **Full verification:**

   ```bash
   yarn lint
   yarn workspace stellar-soroban-snap test
   yarn workspace stellar-soroban-snap-connector test
   yarn workspace stellar-soroban-snap-connector build
   ```

6. **Check the pack contents** of both packages, so nothing unintended ships and nothing needed is missing:

   ```bash
   yarn workspace stellar-soroban-snap pack --dry-run
   yarn workspace stellar-soroban-snap-connector pack --dry-run
   ```

7. **Commit and tag** the release commit, then push with tags:

   ```bash
   git tag -a vX.Y.Z <commit> -m "Release X.Y.Z: <one-line summary>"
   ```

   Release tags use a `v` prefix, distinguishing them from the `phase-N` development tags described in [PLAN.md](PLAN.md).

8. **Publish both packages** from the tagged commit, snap first:

   ```bash
   yarn workspace stellar-soroban-snap npm publish
   yarn workspace stellar-soroban-snap-connector npm publish
   ```

   `prepublishOnly: mm-snap manifest` regenerates the manifest shasum as part of the snap publish. Verify both npm pages render afterwards.

9. **Submit to the Snaps Directory** with the new version, the audit report, screenshots, and a demo video. Allowlisting is per version: until the review completes, users installing through the Directory continue to get the previous listed version.

10. **After the listing is live:** update `packages/site/.env.production` (`GATSBY_SNAP_ORIGIN`, `GATSBY_SNAP_VERSION`) and redeploy the companion dapp, and open or update the Stellar Wallets Kit PR to reference the new version.

## Binding a release to the audited artifact

The identity and version checks that run in CI derive their expected values
from the checkout being built: they prove internal consistency, not that the
checkout is the audited release. A build from an unreviewed or substituted
checkout would pass all of them. Provenance therefore comes from process, and
every step below is mandatory for a production release:

1. **Publish only from the annotated release tag** (`vX.Y.Z`) created on the
   protected default branch. Record the tagged commit hash in the changelog
   entry and in the release notes; the audit report must name the same
   commit. Never publish from a working tree, an untagged commit, or a
   branch.
2. **Treat the audited snap ID and version as protected release inputs.**
   When running the production site build or the release CI job, take
   `GATSBY_SNAP_ORIGIN` and `GATSBY_SNAP_VERSION` from the release record
   (the changelog entry for the audited version), not from whatever the
   checkout happens to contain. The build fails if they disagree with the
   checkout, which is the drift signal this step exists to catch.
3. **Verify the artifact, not just the build.** After `npm publish`, download
   the published tarball with `npm pack stellar-soroban-snap@X.Y.Z` in a
   clean environment, unpack it, and check that `snap.manifest.json`'s
   `shasum` matches a bundle rebuilt from the tagged commit with the pinned
   Node 22 toolchain (the reproducibility procedure in
   [PHASE-5.md](PHASE-5.md)). Archive the tarball hash with the release.
4. **Retain an attestation.** Keep the CI run URL of the release build, the
   dependency audit, SBOM, and scan outputs together with the tag, so the
   published artifact can later be traced to the audited inputs.

## First release

The first release is not routine, and its ordering is fixed by the audit:

1. Third-party audit completes and fixes land (mandatory: the entropy permission is audit-gated).
2. Freeze the release commit, re-run the mainnet CORS probe, and run the Snapper scan on that commit; commit the report to [`audits/scans/`](../audits/scans/).
3. Confirm `stellar-soroban-snap` and `stellar-soroban-snap-connector` are still unclaimed on npm before publishing.
4. Then follow the checklist above.

Detail for each of these is in [PHASE-5.md](PHASE-5.md).
