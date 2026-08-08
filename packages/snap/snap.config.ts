import type { SnapConfig } from '@metamask/snaps-cli';
import { merge } from '@metamask/snaps-cli';
import { dirname, resolve } from 'path';

// Use the exact webpack instance bundled with snaps-cli — a second webpack
// copy in the tree produces plugins that cannot tap the CLI's compiler.
// eslint-disable-next-line @typescript-eslint/no-require-imports, import-x/no-dynamic-require, @typescript-eslint/no-unsafe-assignment
const webpack = require(
  require.resolve('webpack', {
    paths: [dirname(require.resolve('@metamask/snaps-cli/package.json'))],
  }),
);

// Insecure randomness must never be used in this snap. The only occurrences
// in the dependency graph are inside bignumber.js's `BigNumber.random()`
// (shipped pre-minified within @stellar/stellar-sdk, so parser-level
// replacement like DefinePlugin cannot reach it), which also probes
// Math.random once at module init — so a throwing stub would crash the
// bundle at load. Rewrite the emitted bundle to back every call with
// crypto.getRandomValues instead.
const SECURE_RANDOM =
  '(() => crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000)';

class StripInsecureRandomnessPlugin {
  apply(compiler: any): void {
    compiler.hooks.thisCompilation.tap(
      'StripInsecureRandomness',
      (compilation: any) => {
        compilation.hooks.processAssets.tap(
          {
            name: 'StripInsecureRandomness',
            stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
          },
          (assets: Record<string, any>) => {
            for (const assetName of Object.keys(assets)) {
              if (!assetName.endsWith('.js')) {
                continue;
              }
              const source = assets[assetName].source().toString();
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
