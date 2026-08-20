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

   A non-empty diff means the committed manifest was stale; commit the regenerated one. Builds are reproducible on the supported runtime (the exact Node 22 release pinned in `.nvmrc`, see [Toolchain pin](#toolchain-pin) below and [PHASE-5.md](PHASE-5.md)), so the shasum a reviewer computes will match.

5. **Full verification:**

   ```bash
   yarn lint
   yarn workspace stellar-soroban-snap test
   yarn workspace stellar-soroban-snap-connector test
   yarn workspace stellar-soroban-snap-connector build
   ```

6. **Check the pack contents** of both packages, so nothing unintended ships and nothing needed is missing. `prepack` runs `scripts/check-publish-env.mjs`, which refuses to pack outside the release workflow unless told this is a local inspection:

   ```bash
   ALLOW_UNSIGNED_PACK=1 yarn workspace stellar-soroban-snap pack --dry-run
   ALLOW_UNSIGNED_PACK=1 yarn workspace stellar-soroban-snap-connector pack --dry-run
   ```

7. **Commit and tag** the release commit, then push with tags:

   ```bash
   git tag -a vX.Y.Z <commit> -m "Release X.Y.Z: <one-line summary>"
   ```

   Release tags use a `v` prefix, distinguishing them from the `phase-N` development tags described in [PLAN.md](PLAN.md).

8. **Publish by pushing the tag.** Publishing runs in CI, not from a laptop:

   ```bash
   git push origin vX.Y.Z
   ```

   That triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which runs as two jobs:

   - **`build`** (no secrets, no OIDC token) re-runs every CI gate against the tagged checkout, verifies the tag matches `packages/snap/package.json`'s version, re-verifies the manifest seal immediately before packing (the test step rebuilds the bundle, and `mm-snap build` rewrites the manifest, so the check after the first build is not enough on its own), confirms with `mm-snap manifest` that the committed manifest's shasum matches the bundle on disk, packs both tarballs, compares the snap tarball's manifest, icon, and bundle byte for byte against the committed and validated files, and records each tarball's SHA-256 as a job output.
   - **`publish`** (the only job with `id-token: write`, inside the `npm-publish` environment) never checks out the repository. It downloads the tarballs, refuses them unless their digests equal the ones the build job recorded, and runs `npm publish <tarball> --provenance`, snap first and connector second (the connector pins the snap version it installs, so the reverse order leaves a window in which a dapp can install a broken pair). Authentication is npm trusted publishing (OIDC); no npm token exists in the repository's secrets once the one-time setup below is done.

   Verify both npm pages render afterwards, and that each shows the provenance badge.

   To rehearse without publishing, run the workflow manually from the Actions tab with `dry-run` left enabled: it performs every gate and packs both tarballs (downloadable as the `release-tarballs` artifact), but publishes nothing. A manual run with `dry-run` disabled is refused unless it was started from a `vX.Y.Z` tag ref: select the tag in the "Use workflow from" picker, never a branch.

   **Do not publish locally, and in particular do not use `yarn npm publish`.** Yarn 3 (which this repository pins for everything else) implements neither of the two things the snap publish depends on:

   - it does not support npm provenance, and ignores `publishConfig.provenance` rather than failing on it, so it publishes an unattested tarball and exits 0;
   - it does not run `prepublishOnly`, so `mm-snap manifest` never runs and the manifest is never validated against the bundle (that command validates and fails on a mismatch; it does not rewrite the shasum).

   Both omissions are silent and produce a release that looks successful. `scripts/check-publish-env.mjs` runs on `prepack` (the one lifecycle hook both package managers honour on the publish path) and refuses to proceed outside a CI job holding an OIDC token, so this cannot be reached by accident. To pack a tarball locally for inspection, set `ALLOW_UNSIGNED_PACK=1`; the release workflow's build job sets the same variable, deliberately, because it packs in a job that holds no token so that nothing it runs can publish, and npm itself then refuses `--provenance` in the publish job if the token is missing there.

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
   published artifact can later be traced to the audited inputs. CI generates
   the SBOM on every run (CycloneDX JSON via syft, uploaded as the
   `sbom.cdx.json` artifact of the verify job); to regenerate it locally from
   the tagged commit, install [syft](https://github.com/anchore/syft) and run:

   ```bash
   syft scan dir:. -o cyclonedx-json=sbom.cdx.json
   ```

   (The CycloneDX yarn plugin is not an option here: it requires Yarn 4 and
   this repository pins Yarn 3.)

   Both packages publish with npm provenance (`publishConfig.provenance`),
   minted by the `publish` job of `.github/workflows/release.yml`, which is
   the only job granted the `id-token: write` permission that makes an
   attestation possible. The attestation is what ties the published tarball
   to a workflow run and a commit, so it is the one part of this trail that
   does not rest on process discipline. Check for it on the npm page after
   publishing, and record the workflow run URL with the tag. The same run's
   log records the SHA-256 of each tarball as packed and as published; keep
   those with the tag too.

   Note that the npm CLI does refuse to publish a provenance-configured
   package from an environment that cannot attest, but Yarn 3 does not: it
   ignores the setting entirely. Do not rely on the package manager to catch
   this. `scripts/check-publish-env.mjs` is what actually enforces it, on
   `prepack`, for both CLIs.

## Toolchain pin

`.nvmrc` pins the exact Node.js release (a full `major.minor.patch`, not a major line) and both `ci.yml` and `release.yml` install it with `node-version-file: .nvmrc`; the release workflow's publish job receives the same version from the build job so the two jobs cannot drift. Use the same release locally (`nvm use`, or check `node --version` against the file) before rebuilding the bundle for a release. Bump the pin deliberately, in its own commit, and rebuild the bundle afterwards: if the shasum changes with the toolchain, that is information the release record needs.

The native transpiler behind `mm-snap build` (`@swc/core`) is delivered as platform-specific optional packages (`@swc/core-win32-x64-msvc`, `@swc/core-linux-x64-gnu`, and so on). Yarn 3 records no `checksum:` for platform-conditional packages in `yarn.lock`, and `yarn install --immutable` does not fail on them, so they are fetched over TLS with nothing but the registry's word for their contents. The compensating control is the cross-platform reproducibility that the manifest seal enforces: the bundle is built on Windows by the developer (with `@swc/core-win32-x64-msvc`) and the committed manifest carries its shasum; CI then rebuilds on Linux (with `@swc/core-linux-x64-gnu`) and fails unless `git diff --exit-code packages/snap/snap.manifest.json` is clean. A committed manifest that passes CI therefore means two independently fetched, un-checksummed native transpilers produced byte-identical output from the same source. A tampered binary on either side would have to produce exactly the other side's bytes to go unnoticed, which is a far stronger statement than a single checksum over one download. Keep the developer-side and CI-side platforms different on purpose; building the release bundle in CI alone would lose this property.

## One-time setup outside the repository

These are GitHub and npm settings. They are not in version control, so they are listed here so a new maintainer can verify them.

1. **npm trusted publishing (per package).** On npmjs.com, open each package (`stellar-soroban-snap`, `stellar-soroban-snap-connector`), then Settings, then Trusted Publisher, and add a GitHub Actions publisher with organization `SentinelFi`, repository `stellar-metamask-snap`, workflow filename `release.yml`, and environment `npm-publish`. The workflow filename and environment must match exactly; the publish job's OIDC token carries both. Once configured, no npm token is needed and none should exist in the repository's secrets.
2. **First publish of a never-published package.** A trusted publisher is configured on an existing package, so the very first publish of each package cannot use it. For that one run: create a granular access token on npmjs.com scoped to publish (bypassing 2FA for automation, or with 2FA satisfied per npm's current token rules), store it as the repository secret `NPM_BOOTSTRAP_TOKEN`, run the release workflow manually from the release tag with `dry-run` disabled and `bootstrap-token` enabled, then configure the trusted publisher as in step 1 and **delete the secret**. The workflow exposes that secret to the two publish steps only, and only when the input is enabled; every later release must leave it disabled.
3. **Required reviewers on the `npm-publish` environment.** In the repository's Settings, then Environments, then `npm-publish`, enable "Required reviewers" and add the release maintainers; restrict deployment branches and tags to `v*` tags. The publish job waits for approval after the build job has passed every gate, so reviewers approve a specific, already-verified tarball digest (printed in the build job's log) rather than a run that has not yet built anything.
4. **Branch protection on `main`** with required reviews and required CI, and GitHub private vulnerability reporting enabled (it is the reporting channel `SECURITY.md` names).

## Companion dapp security headers

The site ships HTTP security headers in `packages/site/static/_headers`, which Gatsby copies into the publish directory and `gatsby-node.js` then rewrites. Netlify and Cloudflare Pages read that file automatically; **any other host must replicate the same headers in its own configuration** (nginx, Vercel `vercel.json`, S3/CloudFront, and so on), because a host that ignores `_headers` silently ships the site with none of them.

**Copy the headers from the built `packages/site/public/_headers`, not from `static/_headers`.** The `script-src` directive in the source file contains a placeholder token, not the real value: the policy allowlists Gatsby's inline bootstrap scripts by SHA-256 rather than with `'unsafe-inline'`, and those hashes cover the chunk mapping and the compilation hash, so they change on every build. `onPostBuild` computes them and fails the build if the placeholder is missing, so the policy cannot silently regress to allowing arbitrary inline script. **A host that pins these headers by hand must re-copy them after every build**, or the site's own scripts will be blocked.

The headers are:

- `Content-Security-Policy`: `default-src 'self'; script-src 'self' <per-build sha256 hashes>; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. `style-src` keeps `'unsafe-inline'` because styled-components injects rules through the CSSOM at runtime, which no hash can cover; that is a far weaker exposure than inline script.
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

When deploying to a new host, verify the headers are actually served (for example `curl -sI https://<host>/ | grep -i content-security-policy`) before announcing the deployment. Then load the deployed page and confirm the browser console shows no CSP violations and the app actually renders: a stale or mis-copied hash list blocks Gatsby's own bootstrap, which fails as a blank page rather than a visible error.

## First release

The first release is not routine, and its ordering is fixed by the audit:

1. Third-party audit completes and fixes land (mandatory: the entropy permission is audit-gated).
2. Freeze the release commit, re-run the mainnet CORS probe, and run the Snapper scan on that commit; commit the report to [`audits/scans/`](../audits/scans/).
3. Confirm `stellar-soroban-snap` and `stellar-soroban-snap-connector` are still unclaimed on npm before publishing.
4. Then follow the checklist above. Because neither package exists on npm yet, this first publish takes the bootstrap path in [One-time setup outside the repository](#one-time-setup-outside-the-repository): a manual run from the release tag with `bootstrap-token` enabled, followed immediately by configuring the trusted publisher on both packages and deleting the token.

Detail for each of these is in [PHASE-5.md](PHASE-5.md).
