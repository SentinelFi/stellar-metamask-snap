module.exports = {
  testEnvironment: 'node',
  // The site's pure modules: the release-verification helpers behind
  // `gatsby-node.js`, and the utilities that validate user input and
  // provider-reported values before they reach the DOM or an envelope.
  // Components and hooks render through Gatsby and are exercised by the
  // production build and the CI development build instead.
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/*.test.js'],
  moduleNameMapper: {
    // The SDK's root entry and its `/base` entry both resolve to ESM-only
    // builds under Jest's CommonJS runtime; the snap's test setup maps them
    // to the CJS base build (and shims the ESM-only noble dependencies), and
    // the site borrows exactly that mapping so both packages test against
    // one SDK build.
    '^@noble/hashes/sha2(\\.js)?$':
      '<rootDir>/../snap/test/shims/noble-sha2.js',
    '^@noble/ed25519$': '<rootDir>/../snap/test/shims/noble-ed25519.js',
    '^@stellar/stellar-sdk$':
      '<rootDir>/../../node_modules/@stellar/stellar-sdk/lib/cjs/base/index.js',
    '^@stellar/stellar-sdk/base$':
      '<rootDir>/../../node_modules/@stellar/stellar-sdk/lib/cjs/base/index.js',
    // The connector is consumed from its sources here, the way the site's
    // own TypeScript is, so no build step has to precede the tests.
    '^stellar-soroban-snap-connector$': '<rootDir>/../connector/src/index.ts',
    // The connector's imports carry explicit .js extensions (native-ESM
    // emit); strip them so ts-jest resolves the .ts sources.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // The project tsconfig targets bundlers (module: esnext); Jest runs on
    // CommonJS, so override for tests.
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          jsx: 'react-jsx',
          // Classic node resolution does not read package `exports`, so the
          // `/base` subpath the site's utilities import needs an explicit
          // type mapping here, exactly as the snap's test setup does.
          baseUrl: '.',
          paths: {
            '@stellar/stellar-sdk/base': [
              '../../node_modules/@stellar/stellar-sdk/lib/esm/base/index.d.ts',
            ],
          },
        },
      },
    ],
  },
};
