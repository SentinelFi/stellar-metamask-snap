const { readFileSync, existsSync } = require('fs');
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

/**
 * Production guard: a production build must be bound to
 * the audited npm snap release, never the localhost development fallback.
 *
 * Gatsby only exposes non-`GATSBY_` variables to the browser bundle when they
 * come from the `.env.<environment>` file, so this reads the same file the
 * bundle will see instead of trusting `process.env.SNAP_ORIGIN` (an OS-level
 * variable would pass a naive check yet never reach the client).
 *
 * `onPreBuild` only runs for `gatsby build`, so `gatsby develop` keeps the
 * localhost fallback untouched.
 *
 * @param {object} args - Gatsby onPreBuild args.
 * @param {object} args.reporter - Gatsby reporter.
 */
module.exports.onPreBuild = ({ reporter }) => {
  // Build-time environment inspection mirrors what Gatsby itself does when
  // it assembles the client env, so the sync reads are intentional here.
  /* eslint-disable n/no-process-env, n/no-sync */
  const configEnv =
    process.env.GATSBY_ACTIVE_ENV || process.env.NODE_ENV || 'production';
  const envFile = join(__dirname, `.env.${configEnv}`);
  const parsed = existsSync(envFile)
    ? dotenv.parse(readFileSync(envFile, 'utf8'))
    : {};

  const snapOrigin = parsed.SNAP_ORIGIN ?? '';
  const allowLocal =
    (parsed.ALLOW_LOCAL_SNAP ?? process.env.ALLOW_LOCAL_SNAP) === 'true';
  /* eslint-enable n/no-process-env, n/no-sync */

  if (!snapOrigin.startsWith('npm:') && !allowLocal) {
    reporter.panic(
      `Production builds must install the audited snap release. Set ` +
        `SNAP_ORIGIN to the audited "npm:" snap ID (and SNAP_VERSION to the ` +
        `exact audited version) in packages/site/.env.production, or set ` +
        `ALLOW_LOCAL_SNAP=true to explicitly allow a local snap build. ` +
        `Current SNAP_ORIGIN from ${envFile}: "${snapOrigin}".`,
    );
  }

  if (snapOrigin.startsWith('npm:') && !parsed.SNAP_VERSION) {
    reporter.panic(
      `SNAP_VERSION is not set in ${envFile}. A production build must pin ` +
        `the install request to the exact audited release; without it the ` +
        `site would request an unpinned snap. Set SNAP_VERSION to the ` +
        `audited version.`,
    );
  }
};
