const { createHash } = require('crypto');
const { readFileSync, existsSync, readdirSync, writeFileSync } = require('fs');
const { dirname, join, relative: relativePath } = require('path');

// Use the exact webpack instance bundled with Gatsby — a second webpack copy
// in the tree produces plugins that cannot tap Gatsby's compiler.
/* eslint-disable import-x/no-dynamic-require, n/no-extraneous-require */
const webpack = require(
  require.resolve('webpack', {
    paths: [dirname(require.resolve('gatsby/package.json'))],
  }),
);
const dotenv = require(
  require.resolve('dotenv', {
    paths: [dirname(require.resolve('gatsby/package.json'))],
  }),
);
/* eslint-enable import-x/no-dynamic-require, n/no-extraneous-require */

/**
 * Gatsby webpack customization: @stellar/stellar-sdk (stellar-base) expects
 * the Node `Buffer` global, which webpack 5 no longer polyfills by default.
 *
 * @param {object} args - Gatsby onCreateWebpackConfig args.
 * @param {object} args.actions - Gatsby actions.
 */
module.exports.onCreateWebpackConfig = ({ actions }) => {
  actions.setWebpackConfig({
    resolve: {
      fallback: {
        buffer: require.resolve('buffer/'),
      },
    },
    plugins: [
      new webpack.ProvidePlugin({
        Buffer: ['buffer', 'Buffer'],
      }),
    ],
  });
};

const { verifyEmittedIdentity } = require('./release-check');
const snapPackage = require('../snap/package.json');

/**
 * The only snap identity a production build may install. Derived from the
 * snap package itself so the expected name cannot drift from what is
 * actually published.
 */
const EXPECTED_SNAP_ORIGIN = `npm:${snapPackage.name}`;

/**
 * An exact semver release: `major.minor.patch` and nothing else. Ranges
 * (`^1.2.3`, `~1.2`, `latest`) are refused, and so are prerelease and build
 * suffixes (`1.2.3-beta.1`, `1.2.3+build`): the pin names an audited release,
 * and a prerelease is not one.
 *
 * This must stay identical to `EXACT_SEMVER` in
 * `packages/connector/src/snap.ts`. The value accepted here is handed to the
 * connector's constructor at runtime (`WalletContext`), which rejects
 * anything outside its own rule with a `TypeError`; a value that passed the
 * build but failed there would crash the page on load, so the two rules are
 * the same rule.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

/**
 * Reads the build's `.env.<environment>` file, the same file Gatsby loads
 * when it assembles the client environment, together with the process
 * environment that can shadow it.
 *
 * @returns {{ configEnv: string, envFile: string, parsed: Record<string, string>, snapOrigin: string, snapVersion: string, identityConflicts: string[], allowLocal: boolean, devBench: boolean }}
 * The resolved release configuration.
 */
function readReleaseConfig() {
  // Build-time environment inspection mirrors what Gatsby itself does when
  // it assembles the client env, so the sync reads are intentional here.
  /* eslint-disable n/no-process-env, n/no-sync */
  const configEnv =
    process.env.GATSBY_ACTIVE_ENV || process.env.NODE_ENV || 'production';
  const envFile = join(__dirname, `.env.${configEnv}`);
  const parsed = existsSync(envFile)
    ? dotenv.parse(readFileSync(envFile, 'utf8'))
    : {};
  const allowLocal =
    (parsed.ALLOW_LOCAL_SNAP ?? process.env.ALLOW_LOCAL_SNAP) === 'true';
  // Read from both places Gatsby embeds client variables from: the env file
  // (every key) and the process environment (`GATSBY_`-prefixed keys). When
  // both carry a value, the process wins in the emitted JavaScript — Gatsby
  // applies process variables over the file's when it assembles the client
  // env — so the process value is the one every check here must judge. A
  // stray variable on a build host is exactly the case this has to catch.
  const devBench =
    (process.env.GATSBY_DEV_BENCH ?? parsed.GATSBY_DEV_BENCH) === 'true';

  // The snap identity gets the same dual-source read, plus a stricter rule:
  // the two sources must AGREE. Judging only the effective value would let a
  // host variable that happens to name a plausible identity pass the shape
  // checks below while the env file — the reviewed, committed source of
  // truth — says something else. Each disagreement is recorded so the
  // release build can refuse it by name instead of verifying one source and
  // shipping the other.
  const fileSnapOrigin = parsed.GATSBY_SNAP_ORIGIN;
  const fileSnapVersion = parsed.GATSBY_SNAP_VERSION;
  const processSnapOrigin = process.env.GATSBY_SNAP_ORIGIN;
  const processSnapVersion = process.env.GATSBY_SNAP_VERSION;
  /* eslint-enable n/no-process-env, n/no-sync */
  const identityConflicts = [];
  if (
    processSnapOrigin !== undefined &&
    fileSnapOrigin !== undefined &&
    processSnapOrigin !== fileSnapOrigin
  ) {
    identityConflicts.push(
      `GATSBY_SNAP_ORIGIN is "${fileSnapOrigin}" in ${envFile} but ` +
        `"${processSnapOrigin}" in the process environment`,
    );
  }
  if (
    processSnapVersion !== undefined &&
    fileSnapVersion !== undefined &&
    processSnapVersion !== fileSnapVersion
  ) {
    identityConflicts.push(
      `GATSBY_SNAP_VERSION is "${fileSnapVersion}" in ${envFile} but ` +
        `"${processSnapVersion}" in the process environment`,
    );
  }

  return {
    configEnv,
    envFile,
    parsed,
    // The effective values: what the client bundle will actually carry.
    snapOrigin: processSnapOrigin ?? fileSnapOrigin ?? '',
    snapVersion: processSnapVersion ?? fileSnapVersion ?? '',
    identityConflicts,
    allowLocal,
    devBench,
  };
}

/**
 * Production guard: a production build must be bound to the audited npm snap
 * release, never the localhost development fallback and never some other npm
 * package.
 *
 * The identity is judged from both sources Gatsby embeds client variables
 * from — the `.env.<environment>` file and the process environment — with
 * the process value taken as the effective one, because that is the
 * precedence the emitted JavaScript gets. The two sources must also agree:
 * a variable on the build host that shadows the committed env file is
 * refused by name, not silently verified around. `onPostBuild` below
 * re-verifies that the effective values actually reached the build output.
 *
 * `onPreBuild` only runs for `gatsby build`, so `gatsby develop` keeps the
 * localhost fallback untouched.
 *
 * @param {object} args - Gatsby onPreBuild args.
 * @param {object} args.reporter - Gatsby reporter.
 */
module.exports.onPreBuild = ({ reporter }) => {
  const {
    configEnv,
    envFile,
    snapOrigin,
    snapVersion,
    identityConflicts,
    allowLocal,
    devBench,
  } = readReleaseConfig();

  if (allowLocal) {
    // The bypass exists for development builds and is refused outright for a
    // production one. `gatsby build` always runs with NODE_ENV=production,
    // so "a development build" has to be declared, and Gatsby's own way of
    // declaring it is GATSBY_ACTIVE_ENV (which also selects the env file the
    // client bundle is assembled from). Without that declaration a build
    // host with ALLOW_LOCAL_SNAP left in its environment would otherwise
    // produce an artifact bound to an unverified, possibly localhost, snap
    // and ship it with nothing worse than a warning in a log nobody reads.
    if (configEnv === 'production') {
      reporter.panic(
        `ALLOW_LOCAL_SNAP=true is not permitted for a production build. ` +
          `A release build must be bound to the audited snap release; unset ` +
          `ALLOW_LOCAL_SNAP, or, for a local development build, declare it ` +
          `as one with GATSBY_ACTIVE_ENV=development (the build then reads ` +
          `.env.development and is not a deployable artifact).`,
      );
    }
    return;
  }

  // A build host variable shadowing the committed env file rebinds the page
  // to whatever snap the variable names, while every file-based check keeps
  // passing. Refused outright for a release build; the development path
  // above stays usable for local workflows, whose artifacts are already
  // marked unverified and undeployable.
  if (identityConflicts.length > 0) {
    reporter.panic(
      `The snap identity is being overridden by the build host's ` +
        `environment: ${identityConflicts.join('; ')}. The emitted ` +
        `JavaScript would carry the environment's value, not the file's. ` +
        `Unset the stray variable (or correct ${envFile}) so the two ` +
        `sources agree.`,
    );
  }

  // The connector bench (raw SEP-43 method buttons with the JSON response,
  // including signed envelopes, shown verbatim) is a development surface. It
  // is rendered only when GATSBY_DEV_BENCH is exactly "true", and a release
  // build refuses that value from either source Gatsby would embed it from,
  // so the bench cannot reach a deployed page through a stray variable.
  if (devBench) {
    reporter.panic(
      `GATSBY_DEV_BENCH=true is not permitted for a release build: the ` +
        `connector bench is a development surface and must not ship. Unset ` +
        `it (in ${envFile} and in the environment), or build a development ` +
        `artifact with ALLOW_LOCAL_SNAP=true and GATSBY_ACTIVE_ENV=development.`,
    );
  }

  // Exact identity, not merely an "npm:" prefix: a prefix check would accept
  // any package, including an unaudited one with a confusable name.
  if (snapOrigin !== EXPECTED_SNAP_ORIGIN) {
    reporter.panic(
      `Production builds must install the audited snap release. ` +
        `GATSBY_SNAP_ORIGIN must be exactly "${EXPECTED_SNAP_ORIGIN}", ` +
        `but ${envFile} has "${snapOrigin}". Set it to the audited snap ID, ` +
        `or build a development artifact with ALLOW_LOCAL_SNAP=true and ` +
        `GATSBY_ACTIVE_ENV=development.`,
    );
  }

  // Exact version, not a range: a range lets npm resolve to a release that
  // was never audited.
  if (!EXACT_VERSION.test(snapVersion)) {
    reporter.panic(
      `GATSBY_SNAP_VERSION must be an exact version (for example "1.2.3"), but ` +
        `${envFile} has "${snapVersion}". A range or tag would let the ` +
        `install resolve to a release that was never audited.`,
    );
  }

  // The configured browser version must be the version of the snap package
  // this release is assembled from, not merely exact-semver-shaped: an
  // otherwise valid stale value would make the site pin (and demand at
  // runtime) a different release than the one being shipped. Note this
  // check is still relative to the checkout; binding the checkout itself to
  // the audited release is the release process's job (docs/RELEASE.md).
  if (snapVersion !== snapPackage.version) {
    reporter.panic(
      `GATSBY_SNAP_VERSION ("${snapVersion}") does not match the snap ` +
        `package version ("${snapPackage.version}"). The site would pin a ` +
        `different release than the one being built.`,
    );
  }
};

/** The token in `static/_headers` that build-time script hashes replace. */
const HASH_PLACEHOLDER = '{{INLINE_SCRIPT_HASHES}}';

/**
 * Matches an inline `<script>` (one with no `src` attribute). Gatsby emits a
 * handful of these to bootstrap the runtime: the page path, the chunk
 * mapping, and the compilation hash.
 */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gu;

/**
 * Recursively collects every file under a directory whose name matches.
 *
 * @param {string} dir - The directory to walk.
 * @param {(name: string) => boolean} matches - Filename predicate.
 * @returns {string[]} Absolute paths of every matching file.
 */
function collectFiles(dir, matches) {
  // eslint-disable-next-line n/no-sync
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath, matches);
    }
    return entry.isFile() && matches(entry.name) ? [fullPath] : [];
  });
}

/**
 * Replaces the CSP placeholder in `public/_headers` with the SHA-256 hashes of
 * every inline script the build actually emitted.
 *
 * Why this exists rather than a static `'unsafe-inline'`: the dapp is the page
 * that discovers the wallet provider and drives the user's snap interactions,
 * so it is exactly the page where an injected-markup XSS would be most useful
 * to an attacker, and `'unsafe-inline'` disables CSP as a defence against
 * precisely that. Gatsby's inline scripts are few, small, and fixed per build,
 * so hashing them costs nothing and closes the hole.
 *
 * The hashes must be computed here rather than committed: they cover the
 * chunk mapping and the compilation hash, which change on every build.
 *
 * Failing loudly when the placeholder is absent is deliberate. A silent no-op
 * would leave whatever `script-src` the file happens to contain, and the most
 * likely way to reach that state is someone "simplifying" the header back to
 * `'unsafe-inline'`, which is the regression this whole mechanism exists to
 * prevent.
 *
 * @param {object} reporter - Gatsby reporter.
 */
function writeScriptHashes(reporter) {
  const publicDir = join(__dirname, 'public');
  const headersPath = join(publicDir, '_headers');
  // eslint-disable-next-line n/no-sync
  if (!existsSync(headersPath)) {
    reporter.panic(
      `No _headers file in the build output. static/_headers is the source ` +
        `of the site's security headers and must be copied into public/.`,
    );
    return;
  }

  // eslint-disable-next-line n/no-sync
  const headers = readFileSync(headersPath, 'utf8');
  if (!headers.includes(HASH_PLACEHOLDER)) {
    reporter.panic(
      `static/_headers no longer contains the ${HASH_PLACEHOLDER} placeholder, ` +
        `so the Content-Security-Policy could not be given the hashes of the ` +
        `build's inline scripts. Restore the placeholder in script-src. Do not ` +
        `replace it with 'unsafe-inline': that would re-enable arbitrary ` +
        `inline script on the page that drives the user's snap interactions.`,
    );
    return;
  }

  const hashes = new Set();
  for (const path of collectFiles(publicDir, (name) =>
    name.endsWith('.html'),
  )) {
    // eslint-disable-next-line n/no-sync
    const html = readFileSync(path, 'utf8');
    for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
      // A CSP hash covers the element's exact text content, byte for byte.
      hashes.add(
        `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`,
      );
    }
  }

  if (hashes.size === 0) {
    // Not obviously benign: it more likely means the inline-script pattern
    // stopped matching what Gatsby emits (an upgrade changing the markup)
    // than that the scripts genuinely disappeared. Shipping a script-src with
    // no hashes would break the site, so say so rather than write it.
    reporter.panic(
      `Found no inline scripts in the build output. The CSP would then allow ` +
        `no inline script at all and Gatsby's runtime bootstrap would be ` +
        `blocked. Check whether the emitted markup changed.`,
    );
    return;
  }

  // `replaceAll`, not `replace`: a string pattern replaces only the first
  // match, and any prose above the directive that names the token would then
  // absorb the hashes and leave the directive itself unsubstituted, shipping a
  // literal placeholder as a script-src source expression.
  // eslint-disable-next-line n/no-sync
  writeFileSync(
    headersPath,
    headers.replaceAll(HASH_PLACEHOLDER, [...hashes].sort().join(' ')),
    'utf8',
  );
  reporter.info(
    `CSP: allowlisted ${hashes.size} inline script hash(es) in _headers.`,
  );
}

/**
 * Recursively collects every `.js` file under a directory.
 *
 * Gatsby does not emit all JavaScript at the top level of `public/`: webpack
 * chunks, page-data component chunks, and framework bundles land in
 * subdirectories, and which of them carries the substituted env values is an
 * implementation detail that moves between Gatsby versions. A non-recursive
 * scan could miss the one file that matters and either panic on a good build
 * or, worse, be satisfied by an unrelated top-level file.
 *
 * @param {string} dir - The directory to walk.
 * @returns {string[]} Absolute paths of every `.js` file found.
 */
function collectScripts(dir) {
  // eslint-disable-next-line n/no-sync
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectScripts(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

/**
 * Post-build verification: confirm the values actually reached the emitted
 * artifact.
 *
 * The pre-build guard checks configuration; this checks the artifact. Gatsby
 * exposing non-`GATSBY_` variables from an env file to browser code is
 * behaviour that could change on upgrade, and if it did, the guard would
 * still pass while the shipped bundle silently fell back to the localhost
 * development snap. Reading the build output is the only check that cannot be
 * fooled by that; the verifier itself lives in `release-check.js` so it can
 * be tested with a fake artifact.
 *
 * @param {object} args - Gatsby onPostBuild args.
 * @param {object} args.reporter - Gatsby reporter.
 */
module.exports.onPostBuild = ({ reporter }) => {
  const { snapOrigin, snapVersion, allowLocal } = readReleaseConfig();

  // Before the release checks, and deliberately outside the ALLOW_LOCAL_SNAP
  // bypass below: the security headers are not part of the release-identity
  // question, and a development build must exercise this path too, otherwise
  // CI (which builds the site with ALLOW_LOCAL_SNAP=true) would never run it
  // and a regression would surface only in a release build.
  writeScriptHashes(reporter);

  if (allowLocal) {
    // The bypass exists for local development builds only, and onPreBuild
    // has already refused it for a production build, so this branch is only
    // reached for a build declared as development. Still make it loud: an
    // artifact built this way carries no verified snap identity and may
    // request the localhost development snap from every visitor.
    reporter.warn(
      `ALLOW_LOCAL_SNAP=true: release verification was SKIPPED. ` +
        `This artifact is a development build bound to an unverified ` +
        `(possibly localhost) snap and MUST NOT be deployed.`,
    );
    return;
  }

  /* eslint-disable n/no-sync */
  const publicDir = join(__dirname, 'public');
  // Paths are carried alongside the contents so a failure names the file it
  // is about. They are reported relative to `public/`, and the walk order is
  // the filesystem's, so an index into the list would identify nothing.
  const relative = (path) => relativePath(publicDir, path);
  const scripts = collectScripts(publicDir).map((path) => ({
    path: relative(path),
    code: readFileSync(path, 'utf8'),
  }));
  const documents = collectFiles(publicDir, (name) =>
    name.endsWith('.html'),
  ).map((path) => ({ path: relative(path), html: readFileSync(path, 'utf8') }));
  /* eslint-enable n/no-sync */

  // Two independent properties, neither sufficient alone: every emitted page
  // states the identity its configuration resolved (the meta tags
  // `gatsby-ssr.tsx` renders from `src/config`), and no emitted script still
  // reads the configuration variables at runtime, which is what an
  // unsubstituted browser bundle would do. See `verifyEmittedIdentity`.
  const problems = verifyEmittedIdentity(
    { documents, scripts },
    { snapOrigin, snapVersion },
  );
  if (problems.length > 0) {
    reporter.panic(
      `The built site does not carry the audited snap identity:\n  ${problems.join(
        '\n  ',
      )}\nThe browser bundle would fall back to the development snap. Check ` +
        `how the Gatsby version in use exposes environment variables to ` +
        `client code and to server rendering.`,
    );
  }

  reporter.info(
    `Release check: the built site requests ${snapOrigin} @ ${snapVersion}.`,
  );
};
