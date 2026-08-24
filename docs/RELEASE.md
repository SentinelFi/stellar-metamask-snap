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

If any dependency, RPC method, or renderable operation type changed since the
last release, first work through
[Re-derive on a dependency or surface change](#re-derive-on-a-dependency-or-surface-change).
Those checks are not in CI, because what they depend on lives upstream or in a
second hand-maintained list.

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

   That triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which runs as three jobs:

   - **`build`** (no secrets, no OIDC token) re-runs every CI gate against the tagged checkout, confirms that both committed build-output seals still describe what it just built, and uploads the two `dist/` trees. Everything that runs third-party code runs here: eslint, jest, ts-jest, `mm-snap`, the SBOM action, every dev dependency. It packs nothing and vouches for nothing.

   - **`seal`** (no secrets, no OIDC token, and nothing installed from this repository) checks out the release commit on a fresh runner, records an immutable baseline, re-checks the tag, downloads the build output, verifies it against the committed digests, packs both tarballs with lifecycle scripts disabled, verifies each archive completely, and records each tarball's SHA-256 as a job output.

     **Why sealing is a separate job.** Steps in one job share more than a working directory. `GITHUB_PATH` and `GITHUB_ENV` are environment files whose contents apply to every later step in that job, so code running anywhere in the build job can put its own `git`, `tar`, or `sha256sum` earlier on the `PATH`, or set a shell hook such as `BASH_ENV` that later non-interactive shells source before running anything. Verification performed after that point is verification the attacker configured: it can be made to pass over a substituted archive and then emit that archive's genuine digest for the publish job to honour, and no immutable Git baseline helps, because the same process controls the commands that compare against it. Those environment files are scoped to one job, and each job is a fresh runner, so nothing the build job's dependencies did reaches the seal job. It installs nothing from this repository, which is what lets it trust the tools it invokes by name.

     **What it compares against is committed, not produced.** Each package carries a `dist.sha256` written at build time and reviewed in the diff, and both CI and the build job fail when a rebuild disagrees with it. A digest a build job takes of its own output proves only that the same bytes were later packed; it cannot say they are a faithful compilation of the reviewed source, because the compiler had already run. Until this existed the connector had no pre-build anchor at all, so a compromised compiler emitting malicious JavaScript into an expected file would have been recorded, packed, and published faithfully, with no Git mutation and no forged hash anywhere. The format is `sha256sum`'s, deliberately: verifying needs coreutils and nothing else, and a verifier that had to run this repository's tooling would be a verifier trusting the graph it exists to check.

     **The baseline is read from `$GITHUB_SHA`,** the commit that triggered the workflow, not from `HEAD` or from any path in the working tree. Local git state is writable from inside a job: a dependency's install script can commit, amend, or install a replace ref, and afterwards `git diff --exit-code`, `git status`, and `git show HEAD:<path>` all agree with each other and all describe the wrong tree. The step asserts that the checkout's `HEAD` is the triggering commit, asserts that no replace refs exist, reads every file's blob id with `--no-replace-objects`, and fetches the tag from the server URL rather than from a remote name that local configuration could point elsewhere.

     **Verification of each archive is complete rather than sampled.** An archive is published whole, so the files nobody compared are exactly where something would be added: `package.json` alone decides what npm consumers install and execute. Each tarball is checked for an exact file inventory (nothing missing, nothing extra), for entry types (regular files and directories only, so no symlink or hard link can make an extracted tree differ from its listing), for the committed bytes of every static file, and for every emitted file against the committed digests, verified inside the extracted archive rather than in a copy sitting beside it.

     The snap manifest's shasum is deliberately not recomputed in the workflow. It is not a hash of the bundle file but MetaMask's own checksum over a canonical form, and reimplementing it in shell would be a second, weaker implementation of the thing being checked, in the job whose whole purpose is to be a trustworthy checker. The bundle is verified here against `dist.sha256` instead, which is a plain digest of the same bytes reviewed in the same diff; `mm-snap manifest` confirms the manifest against the bundle in the build job, and the publish job then ships the sealed archives byte-for-byte. Publishing a tarball runs no lifecycle scripts, so nothing re-runs at publish time: the control is the build-job check plus the seal, not a publish-time hook.

   - **`publish`** (the only job with `id-token: write`, inside the `npm-publish` environment) never checks out the repository. It downloads the tarballs, refuses them unless their digests equal the ones the seal job recorded, and runs `npm publish <tarball> --provenance`, snap first and connector second (the connector pins the snap version it installs, so the reverse order leaves a window in which a dapp can install a broken pair). Authentication is npm trusted publishing (OIDC); no npm token exists in the repository's secrets once the one-time setup below is done.

   Verify both npm pages render afterwards, and that each shows the provenance badge.

   To rehearse without publishing, run the workflow manually from the Actions tab with `dry-run` left enabled: it performs every gate and packs both tarballs (downloadable as the `release-tarballs` artifact), but publishes nothing. A manual run with `dry-run` disabled is refused unless it was started from a `vX.Y.Z` tag ref: select the tag in the "Use workflow from" picker, never a branch.

   **Do not publish locally, and in particular do not use `yarn npm publish`.** Yarn 3 (which this repository pins for everything else) implements neither of the two things the snap publish depends on:

   - it does not support npm provenance, and ignores `publishConfig.provenance` rather than failing on it, so it publishes an unattested tarball and exits 0;
   - it does not run `prepublishOnly`, so `mm-snap manifest` never runs and the manifest is never validated against the bundle (that command validates and fails on a mismatch; it does not rewrite the shasum).

   Both omissions are silent and produce a release that looks successful. `scripts/check-publish-env.mjs` runs on `prepack` (the one lifecycle hook both package managers honour on the publish path) and refuses to proceed outside a CI job holding an OIDC token, so this cannot be reached by accident. To pack a tarball locally for inspection, set `ALLOW_UNSIGNED_PACK=1`.

The release workflow does not set that variable. The seal job packs with `--ignore-scripts` instead, which is the point of packing that way: nothing from the dependency graph runs in the job that verifies the archives. The question the script asks is still answered, in the place where it can be enforced rather than asserted: neither the build job nor the seal job holds an OIDC token by design, and npm itself refuses `--provenance` in the publish job if the token is missing there.

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

This same argument now covers the connector, which had no equivalent until `packages/connector/dist.sha256` was committed: `tsc` emits it, the digest is reviewed in the diff, and CI fails if a rebuild on another platform disagrees. Regenerate it by building the package (`yarn workspace stellar-soroban-snap-connector build` writes it, exactly as `mm-snap build` rewrites the snap's manifest shasum), and read the diff when it changes: a digest that moves without a source change is the signal this file exists to raise.

The native transpiler behind `mm-snap build` (`@swc/core`) is delivered as platform-specific optional packages (`@swc/core-win32-x64-msvc`, `@swc/core-linux-x64-gnu`, and so on). Yarn 3 records no `checksum:` for platform-conditional packages in `yarn.lock`, and `yarn install --immutable` does not fail on them, so they are fetched over TLS with nothing but the registry's word for their contents. The compensating control is the cross-platform reproducibility that the manifest seal enforces: the bundle is built on Windows by the developer (with `@swc/core-win32-x64-msvc`) and the committed manifest carries its shasum; CI then rebuilds on Linux (with `@swc/core-linux-x64-gnu`) and fails unless `git diff --exit-code packages/snap/snap.manifest.json` is clean. A committed manifest that passes CI therefore means two independently fetched, un-checksummed native transpilers produced byte-identical output from the same source. A tampered binary on either side would have to produce exactly the other side's bytes to go unnoticed, which is a far stronger statement than a single checksum over one download. Keep the developer-side and CI-side platforms different on purpose; building the release bundle in CI alone would lose this property.

## Re-derive on a dependency or surface change

A few of this repository's safety properties are held by something other than a
test or a type: by an upstream union having exactly the arms it has today, or by
two hand-maintained lists agreeing. They hold at the audited commit. They are
the ones to re-check when the thing underneath them moves, because none of them
fails loudly on its own.

Each entry below names its trigger, what would break, and how you would notice.
Work through the entries whose trigger fired; skip the rest.

### Trigger: bumping `@stellar/stellar-sdk`

1. **`setOptions` signer key variants.** `describeSigner` in
   [`packages/snap/src/ui/transaction.tsx`](../packages/snap/src/ui/transaction.tsx)
   names the four `SignerKey` union arms and falls back to the literal string
   `unknown signer type`. Unlike every comparable case in that file, the
   fallback is **not** gated by `findUndisplayableOperation`, so it would be
   displayed rather than refused, on the one operation that changes who controls
   an account.

   It is unreachable at the audited commit: the XDR union has exactly four arms,
   so a fifth discriminant fails to decode before this code runs. A protocol
   addition plus an SDK bump makes it reachable, and nothing would say so. The
   SDK's own `setOptions` decoder has no `else` throw for an unrecognised arm; it
   leaves `result.signer` carrying only `weight`. `OperationSigner` in the same
   file is a hand-written structural type, so a new field does not fail
   typecheck either.

   Check that the arms the SDK handles are still exactly the four
   `describeSigner` names:

   ```bash
   grep -rho 'arm === "[A-Za-z0-9]*"' node_modules/@stellar/stellar-sdk/lib --include=operation.js | sort -u
   ```

   If a fifth appears, gate it in `findUndisplayableOperation` so the signature
   is refused, matching the treatment `extraSigners` already gets, before
   shipping the bump.

2. **Bundle markers.** [`audits/known-advisories.json`](../audits/known-advisories.json)
   proves axios, form-data, and follow-redirects are absent from the shipped
   bundle by grepping it for string literals from their runtime code. Re-derive
   those markers whenever the SDK crosses a major version, as that file's own
   note instructs: minification strips package names, so a marker upstream has
   reworded silently disarms the check while CI still reports it clean.

3. **`EXPECTED_RANDOM_REWRITES`.** `snap.config.ts` fails the build when the
   `Math.random` occurrence count moves. This one does announce itself. When it
   fires, confirm the new occurrences are real call sites rather than string
   literals, then update the constant deliberately; never update it to turn a
   red build green.

4. **Keypair buffer semantics.** `wipeKeypair` and `deriveFromNode` depend on
   `Keypair.fromRawEd25519Seed` copying its buffer rather than retaining it, and
   on `rawSecretKey()` returning the live buffer. Both are asserted in
   `packages/snap/src/keys/index.test.ts`, so a change fails the suite rather
   than silently leaving key material reachable. No manual check needed; listed
   so the failure is recognisable for what it is when it happens.

### Trigger: adding an RPC method

1. **Dialog throttle membership.** A method that can open a dialog must be in
   `DIALOG_METHODS` in `packages/snap/src/rpc/throttle.ts`, or it bypasses the
   consecutive-rejection cooldown entirely.

2. **Global work budget.** A method that makes an outbound request must claim a
   global budget (`takePredialogBudget` or `takeTokenReadBudget`), not only a
   per-origin entry in `RATE_LIMITS`: every control keyed on `origin` resets per
   subdomain, which is the reason the global budgets exist.

3. **Rate-limit map sizing.** `requestLog` in
   [`packages/snap/src/rpc/limiter.ts`](../packages/snap/src/rpc/limiter.ts) is
   keyed per `(origin, method)` pair but capped by `MAX_TRACKED_ORIGINS` (100).
   With the current 13 rate-limited methods that is roughly 7 concurrently
   active origins before LRU eviction begins resetting live windows. Eviction
   fails open, which is the correct direction for an availability control and
   why this is not urgent, but the constant bounds fewer origins than its name
   suggests and the gap widens with every method added. If `RATE_LIMITS` grows
   much beyond its current size, size the cap as
   `MAX_TRACKED_ORIGINS * RATE_LIMITS.size`, or key the map by origin with a
   per-method sub-record so the constant means what it says.

### Trigger: adding a renderable operation type

`SUPPORTED_OPERATION_TYPES` (the allowlist `handlers/sign.tsx` enforces) and the
`renderOperationBody` switch are two hand-maintained lists whose agreement is
what keeps the `default:` "not decoded by the snap" arm dead. Drift converts a
hard refusal into a soft "review the XDR yourself" banner, which is the review
mechanism the fail-closed policy exists to reject.

This one is enforced: the "operation allowlist and renderer parity" suite in
`packages/snap/src/ui/transaction-fidelity.test.tsx` checks both directions,
asserts each fixture really decodes to the type it is filed under, and carries a
positive control so the assertion cannot rot into vacuity. Add the fixture
alongside the allowlist entry and the suite stays green.

### Trigger: bumping `CURRENT_DISCLOSURE_VERSION`

Re-gating a capability on a new disclosure version does not re-gate everything a
standing grant implies. `getAccounts` checks `grantHasCurrentDisclosure`;
`getBalances` and `fund` check only that a grant exists, and both distinguish an
owned address from an unowned one. An origin holding an older grant therefore
keeps a membership oracle for addresses it already knows, after losing
enumeration.

That is a defensible gradient, since probing requires already holding the
address where enumeration does not, and it is empty at the audited commit
because every grant in existence carries version 1. Decide it explicitly at bump
time rather than inheriting it, and record the decision in the
`CURRENT_DISCLOSURE_VERSION` docstring in `packages/snap/src/state/index.ts`.

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

- `Content-Security-Policy`: `default-src 'self'; script-src 'self' <per-build sha256 hashes>; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://horizon.stellar.org https://horizon-testnet.stellar.org https://horizon-futurenet.stellar.org; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. `style-src` keeps `'unsafe-inline'` because styled-components injects rules through the CSSOM at runtime, which no hash can cover; that is a far weaker exposure than inline script.
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
