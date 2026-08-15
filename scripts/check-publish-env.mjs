/**
 * Refuses to pack or publish a release artifact from an environment that
 * cannot produce an npm provenance attestation.
 *
 * Why this exists. Both publishable packages set `publishConfig.provenance`,
 * and the release procedure treats that attestation as the link between the
 * published tarball and the audited commit. Two properties of the toolchain
 * make that assumption unsafe without a guard:
 *
 *   1. Yarn 3 (which this repository pins) does not implement provenance at
 *      all. `yarn npm publish` ignores `publishConfig.provenance` rather than
 *      failing on it, so it publishes an unattested tarball and exits 0.
 *   2. Yarn 3 also does not run `prepublishOnly`, so the snap's
 *      `mm-snap manifest` step is skipped on that path too.
 *
 * Both failures are silent, and both produce a release that looks successful.
 * This script turns them into a loud stop.
 *
 * It is wired to `prepack`, not `prepublishOnly`, precisely because `prepack`
 * is the one lifecycle hook BOTH package managers honour on the publish path.
 *
 * Escape hatch: set `ALLOW_UNSIGNED_PACK=1` to pack locally for inspection.
 * It is deliberately not named "...PUBLISH": anyone reaching for it should be
 * packing, and if they are publishing they should read this file first.
 */

/* eslint-disable n/no-process-env, n/no-process-exit */

// Marks the file as an ES module rather than a script that could be parsed
// either way. It runs for its side effect and exports nothing.
export {};

const OVERRIDE = 'ALLOW_UNSIGNED_PACK';

// GitHub Actions exposes this only to jobs granted `id-token: write`, which
// is exactly the condition npm requires to mint a provenance attestation.
// Testing for the token rather than for `CI` is what makes this check mean
// "provenance is possible here" instead of merely "something automated".
const canAttest =
  process.env.GITHUB_ACTIONS === 'true' &&
  Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);

if (canAttest || process.env[OVERRIDE] === '1') {
  process.exit(0);
}

const packageName = process.env.npm_package_name ?? 'this package';

process.stderr.write(
  `\nRefusing to pack ${packageName} outside a provenance-capable CI job.\n\n` +
    `This package publishes with npm provenance. Producing that attestation\n` +
    `requires an OIDC token, which only a GitHub Actions job with\n` +
    `\`id-token: write\` has. Publishing from anywhere else does not fail on\n` +
    `its own: Yarn 3 ignores \`publishConfig.provenance\` entirely and also\n` +
    `skips \`prepublishOnly\` (so the snap's manifest shasum would not be\n` +
    `regenerated). Both omissions are silent, which is what this check is\n` +
    `here to prevent.\n\n` +
    `To publish a release:\n` +
    `  push an annotated tag \`vX.Y.Z\`, which runs .github/workflows/release.yml\n` +
    `  (or run that workflow manually with dry-run disabled)\n\n` +
    `To pack locally for inspection, without publishing:\n` +
    `  ${OVERRIDE}=1 npm pack --workspace packages/snap\n\n` +
    `See docs/RELEASE.md.\n\n`,
);
process.exit(1);
