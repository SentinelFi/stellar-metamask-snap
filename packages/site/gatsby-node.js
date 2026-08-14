const { readFileSync, existsSync, readdirSync } = require('fs');
const { dirname, join } = require('path');

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

const snapPackage = require('../snap/package.json');

/**
 * The only snap identity a production build may install. Derived from the
 * snap package itself so the expected name cannot drift from what is
 * actually published.
 */
const EXPECTED_SNAP_ORIGIN = `npm:${snapPackage.name}`;

/** An exact semver release. Ranges (`^1.2.3`, `~1.2`, `latest`) are refused. */
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * Reads the build's `.env.<environment>` file, the same file Gatsby loads
 * when it assembles the client environment.
 *
 * @returns {{ envFile: string, parsed: Record<string, string>, snapOrigin: string, snapVersion: string, allowLocal: boolean }}
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
  /* eslint-enable n/no-process-env, n/no-sync */

  return {
    envFile,
    parsed,
    snapOrigin: parsed.GATSBY_SNAP_ORIGIN ?? '',
    snapVersion: parsed.GATSBY_SNAP_VERSION ?? '',
    allowLocal,
  };
}

/**
 * Production guard: a production build must be bound to the audited npm snap
 * release, never the localhost development fallback and never some other npm
 * package.
 *
 * This reads the same `.env.<environment>` file the client bundle is built
 * from, rather than `process.env`: an OS-level variable would pass a naive
 * check here yet never be embedded in the emitted JavaScript. The variables
 * carry Gatsby's documented `GATSBY_` prefix, and `onPostBuild` below
 * re-verifies that they actually reached the build output.
 *
 * `onPreBuild` only runs for `gatsby build`, so `gatsby develop` keeps the
 * localhost fallback untouched.
 *
 * @param {object} args - Gatsby onPreBuild args.
 * @param {object} args.reporter - Gatsby reporter.
 */
module.exports.onPreBuild = ({ reporter }) => {
  const { envFile, snapOrigin, snapVersion, allowLocal } = readReleaseConfig();

  if (allowLocal) {
    return;
  }

  // Exact identity, not merely an "npm:" prefix: a prefix check would accept
  // any package, including an unaudited one with a confusable name.
  if (snapOrigin !== EXPECTED_SNAP_ORIGIN) {
    reporter.panic(
      `Production builds must install the audited snap release. ` +
        `GATSBY_SNAP_ORIGIN must be exactly "${EXPECTED_SNAP_ORIGIN}", ` +
        `but ${envFile} has "${snapOrigin}". Set it to the audited snap ID, ` +
        `or set ALLOW_LOCAL_SNAP=true to explicitly allow a local build.`,
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
 * Whether any emitted script contains `value` as a complete string literal
 * (in either quote style the minifier may choose).
 *
 * A bare substring test is near-vacuous for values like a version number:
 * "1.2.3" appears in dependency banners, source URLs, and unrelated
 * constants all over a production bundle. Requiring the quoted form means
 * the value is present as the actual string literal the client code will
 * read at runtime, not as an accidental fragment of something else.
 *
 * @param {string[]} emitted - The emitted script contents.
 * @param {string} value - The exact string the bundle must carry.
 * @returns {boolean} True when some script contains the quoted literal.
 */
function hasQuotedLiteral(emitted, value) {
  const doubleQuoted = JSON.stringify(value);
  const singleQuoted = `'${value}'`;
  return emitted.some(
    (code) => code.includes(doubleQuoted) || code.includes(singleQuoted),
  );
}

/**
 * Post-build verification: confirm the values actually reached the emitted
 * JavaScript.
 *
 * The pre-build guard checks configuration; this checks the artifact. Gatsby
 * exposing non-`GATSBY_` variables from an env file to browser code is
 * behaviour that could change on upgrade, and if it did, the guard would
 * still pass while the shipped bundle silently fell back to the localhost
 * development snap. Reading the build output is the only check that cannot be
 * fooled by that.
 *
 * @param {object} args - Gatsby onPostBuild args.
 * @param {object} args.reporter - Gatsby reporter.
 */
module.exports.onPostBuild = ({ reporter }) => {
  const { snapOrigin, snapVersion, allowLocal } = readReleaseConfig();

  if (allowLocal) {
    // The bypass exists for local development builds only. Make it loud:
    // an artifact built this way carries no verified snap identity and may
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
  const emitted = collectScripts(publicDir).map((path) =>
    readFileSync(path, 'utf8'),
  );
  /* eslint-enable n/no-sync */

  // The origin must appear as the quoted `npm:<name>` literal and the
  // version as the quoted version literal: the strings client code actually
  // receives from the env substitution.
  const hasOrigin = hasQuotedLiteral(emitted, snapOrigin);
  const hasVersion = hasQuotedLiteral(emitted, snapVersion);

  if (!hasOrigin || !hasVersion) {
    reporter.panic(
      `The built site does not carry the audited snap identity. Expected ` +
        `the quoted literal "${snapOrigin}" (found: ${hasOrigin}) and the ` +
        `quoted version "${snapVersion}" (found: ${hasVersion}) in the ` +
        `emitted JavaScript. The browser bundle would fall back to the ` +
        `development snap. Check how the Gatsby version in use exposes ` +
        `environment variables to client code.`,
    );
  }

  reporter.info(
    `Release check: the built site requests ${snapOrigin} @ ${snapVersion}.`,
  );
};
