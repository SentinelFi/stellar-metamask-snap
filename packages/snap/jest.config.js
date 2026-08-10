module.exports = {
  preset: '@metamask/snaps-jest',
  transform: {
    // Jest runs on CommonJS; the project tsconfig targets the webpack bundle
    // (module: esnext, moduleResolution: bundler), so override for tests.
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
        },
      },
    ],
  },
  // @stellar/stellar-sdk (imported by the TEST files for building fixtures
  // and verifying signatures) depends on ESM-only @noble packages that
  // Jest's CJS runtime cannot load. Map them to node:crypto-backed CJS
  // shims. The snap bundle itself (executed by the snaps-jest simulator)
  // uses the real @noble implementations.
  moduleNameMapper: {
    '^@noble/hashes/sha2(\\.js)?$': '<rootDir>/test/shims/noble-sha2.js',
    '^@noble/ed25519$': '<rootDir>/test/shims/noble-ed25519.js',
    // The SDK's root CJS entry eagerly loads webauth/horizon modules with
    // further ESM-only deps (uint8array-extras, ...). Tests only use base
    // primitives (TransactionBuilder, Keypair, hash, ...), so resolve the
    // package to its CJS base build at runtime; types still come from the
    // root typings.
    '^@stellar/stellar-sdk$':
      '<rootDir>/../../node_modules/@stellar/stellar-sdk/lib/cjs/base/index.js',
  },
};
