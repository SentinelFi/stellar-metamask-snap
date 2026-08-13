module.exports = {
  preset: '@metamask/snaps-jest',
  /*
   * Coverage measures the source modules only, never the test files or the
   * built bundle.
   *
   * Read the report with one caveat in mind: snaps-jest executes the built
   * `dist/bundle.js` inside the snap execution environment, so tests driven
   * through `installSnap` produce NO instrumented coverage of `src`. Every
   * module reachable only that way reports 0% branch coverage however
   * thoroughly it is tested -- `handlers/sign.tsx` is the clearest case, with
   * 42 behavioural assertions across the simulator suites and 0% branches
   * here. The statement percentages those modules do show are module-load
   * side effects, not executed logic.
   *
   * So these numbers are a floor for the in-process unit tests, not a measure
   * of how well the snap is tested. The pattern that does yield real coverage
   * of handler code is calling the handler directly against a mocked `snap`
   * global (see the onUserInput tests in src/multi-account.test.tsx), which is
   * why `index.tsx` and `handlers/home.tsx` report real branch coverage.
   */
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
  ],
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageDirectory: 'coverage',
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
