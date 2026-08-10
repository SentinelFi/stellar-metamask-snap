const { dirname } = require('path');

// Use the exact webpack instance bundled with Gatsby — a second webpack copy
// in the tree produces plugins that cannot tap Gatsby's compiler.
/* eslint-disable import-x/no-dynamic-require, n/no-extraneous-require */
const webpack = require(
  require.resolve('webpack', {
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
