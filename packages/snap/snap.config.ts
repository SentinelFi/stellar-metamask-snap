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

/**
 * How many `Math.random` references the bundle is known to contain. The
 * rewrite below fails the build when the real count differs, so a dependency
 * change that adds one (or that adds the literal in a position where a blind
 * textual replacement would corrupt a string) surfaces at build time rather
 * than silently producing a new shasum. Update deliberately, never to make a
 * red build go green.
 */
const EXPECTED_RANDOM_REWRITES = 7;

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
  // Webpack's own per-plugin logger. Preferred over `console` so the message
  // routes through the compiler's `infrastructureLogging` config like every
  // other build diagnostic, and so build tooling carries no raw console call.
  getLogger: (name: string) => { info: (message: string) => void };
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
              const occurrences = source.split('Math.random').length - 1;
              if (occurrences === 0) {
                continue;
              }
              // This is a textual replacement over emitted bytes, so it also
              // rewrites the literal inside string constants, comments, and
              // regexes. Nothing bundled today contains it in one of those
              // positions, but a dependency bump could, and the corruption
              // would be semantic: the bundle would still parse, still pass
              // the SES evaluation, and still pass CI's "no Math.random
              // remains" grep, because the literal would indeed be gone.
              //
              // Asserting the count is what makes such a change visible: a
              // build whose number moves is a build whose dependencies
              // changed where this rewrite reaches, and it fails below rather
              // than quietly producing a new shasum.
              //
              // The record goes through webpack's own logger, not `console`.
              // Note that `mm-snap` prints its own build summary rather than
              // webpack's stats, so this line is captured in the compilation
              // record but not shown on a successful build. That is deliberate:
              // the throw below is the control, and a happy-path log is not
              // worth a raw console call in build tooling that ships to an
              // audit. CI prints the count separately (see ci.yml).
              compilation
                .getLogger('StripInsecureRandomness')
                .info(
                  `rewrote ${occurrences} Math.random reference(s) in ` +
                    `${assetName} (expected ${EXPECTED_RANDOM_REWRITES}).`,
                );
              if (occurrences !== EXPECTED_RANDOM_REWRITES) {
                throw new Error(
                  `StripInsecureRandomness: expected ${EXPECTED_RANDOM_REWRITES} ` +
                    `Math.random reference(s) in ${assetName}, found ${occurrences}. ` +
                    `A dependency changed where this rewrite applies. Confirm the ` +
                    `new occurrences are real call sites (not string literals) and ` +
                    `update EXPECTED_RANDOM_REWRITES in snap.config.ts.`,
                );
              }
              compilation.updateAsset(
                assetName,
                new webpack.sources.RawSource(
                  source.split('Math.random').join(SECURE_RANDOM),
                ),
              );
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
