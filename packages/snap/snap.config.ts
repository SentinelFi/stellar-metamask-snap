import type { SnapConfig } from '@metamask/snaps-cli';
import { merge } from '@metamask/snaps-cli';
import { dirname, resolve } from 'path';

// Use the exact webpack instance bundled with snaps-cli — a second webpack
// copy in the tree produces plugins that cannot tap the CLI's compiler.
/* eslint-disable @typescript-eslint/no-require-imports, import-x/no-dynamic-require, n/no-extraneous-require */
const webpack = require(
  require.resolve('webpack', {
    paths: [dirname(require.resolve('@metamask/snaps-cli/package.json'))],
  }),
);
/* eslint-enable @typescript-eslint/no-require-imports, import-x/no-dynamic-require, n/no-extraneous-require */

// bignumber.js's `BigNumber.random()` (shipped pre-minified inside
// @stellar/stellar-sdk) references Math.random and probes it at module init.
// DefinePlugin cannot reach the pre-minified source, and a throwing stub
// would crash the bundle at load, so rewrite the emitted bundle to back
// every Math.random call with crypto.getRandomValues.
const SECURE_RANDOM =
  '(() => crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000)';

/** Minimal structural types for the parts of webpack this plugin touches. */
type WebpackSource = { source: () => { toString: () => string } };
type Compilation = {
  hooks: {
    processAssets: {
      tap: (
        options: { name: string; stage: number },
        callback: (assets: Record<string, WebpackSource>) => void,
      ) => void;
    };
  };
  updateAsset: (name: string, source: unknown) => void;
};

class StripInsecureRandomnessPlugin {
  // `compiler` is left untyped: the plugin is added to webpack's own plugins
  // array, whose Compiler type comes from the dynamically-required webpack.
  apply(compiler: any): void {
    compiler.hooks.thisCompilation.tap(
      'StripInsecureRandomness',
      (compilation: Compilation) => {
        compilation.hooks.processAssets.tap(
          {
            name: 'StripInsecureRandomness',
            stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
          },
          (assets) => {
            for (const assetName of Object.keys(assets)) {
              if (!assetName.endsWith('.js')) {
                continue;
              }
              const asset = assets[assetName];
              const source = asset ? asset.source().toString() : '';
              if (source.includes('Math.random')) {
                compilation.updateAsset(
                  assetName,
                  new webpack.sources.RawSource(
                    source.split('Math.random').join(SECURE_RANDOM),
                  ),
                );
              }
            }
          },
        );
      },
    );
  }
}

const config: SnapConfig = {
  input: resolve(__dirname, 'src/index.tsx'),
  server: {
    port: 8080,
  },
  polyfills: {
    buffer: true,
  },
  customizeWebpackConfig: (webpackConfig) =>
    merge(webpackConfig, {
      plugins: [new StripInsecureRandomnessPlugin()],
    }),
};

export default config;
