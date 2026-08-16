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
   *
   * `handlers/sign.tsx` now follows that pattern too, in
   * src/handlers/sign-guards.test.tsx. That matters beyond the number: the
   * module is a dozen independent fail-closed guards, each a single `if`
   * whose removal silently widens what the snap will sign, and while it
   * reported 0% branches no threshold could protect any of them. The
   * thresholds below are the ratchet that now does.
   *
   * src/handlers/access-guards.test.tsx extends the same pattern to the
   * connection boundary, for the same reason. `assertConnected` is one `if`
   * gating `fund`, `getBalances`, `addToken`, `setNetwork`, `getAccounts`,
   * `setActiveAccount`, and account selection on the signing methods, and
   * `resolveSigningKeypair` is one `find` confining signing to revealed
   * indices. Both were simulator-only, so `handlers/account.tsx` reported 3%
   * branches and `handlers/access.tsx` 0% while being well tested, and no
   * threshold could protect either.
   */
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
  ],
  /*
   * Set just under current measured coverage, so an accidental deletion trips
   * them but ordinary refactoring does not. Raise them when coverage rises;
   * never lower them to make a red build go green. Only modules genuinely
   * exercised in-process are listed: a global threshold would be dominated by
   * the simulator-only modules described above and would mean nothing.
   */
  coverageThreshold: {
    // The connection gate and the account registry it protects. `account.tsx`
    // sits lower than the rest of this group because its uncovered remainder
    // is the `addToken` dialog flow, which the simulator suites drive; the
    // branch number here is what protects `assertConnected` itself.
    'src/handlers/access.tsx': { branches: 95, lines: 95 },
    'src/handlers/account.tsx': { branches: 52, lines: 67 },
    'src/handlers/accounts.tsx': { branches: 95, lines: 95 },
    'src/handlers/network.tsx': { branches: 95, lines: 82 },
    'src/handlers/sign.tsx': { branches: 60, lines: 81 },
    // `resolveSigningKeypair`: the bounded-account-resolution claim.
    'src/keys/index.ts': { branches: 72, lines: 90 },
    'src/stellar/token.ts': { branches: 88, lines: 85 },
    'src/rpc/limiter.ts': { branches: 89, lines: 96 },
    // Lines sit lower than branches here: the uncovered lines are the
    // handler-lambda table entries, which the router suite deliberately
    // mocks; the dispatch/laundering/throttle logic itself is what the
    // branch number protects.
    'src/rpc/router.ts': { branches: 95, lines: 72 },
    'src/rpc/throttle.ts': { branches: 75, lines: 91 },
    'src/rpc/validation.ts': { branches: 82, lines: 98 },
    'src/state/index.ts': { branches: 75, lines: 85 },
    'src/stellar/horizon.ts': { branches: 82, lines: 97 },
    'src/stellar/http.ts': { branches: 95, lines: 95 },
    'src/stellar/rpc.ts': { branches: 90, lines: 96 },
    'src/stellar/safety.ts': { branches: 78, lines: 95 },
    // The balance-change decoder: what a Soroban dialog says a contract call
    // does to the user's own balances. Its failure modes are display-integrity
    // failures (a movement dropped, one attributed to the wrong account, an
    // asset name accepted from a contract that cannot prove it), and each is a
    // branch rather than a line, which is why the branch number is the one
    // that matters here.
    'src/stellar/events.ts': { branches: 78, lines: 88 },
    // Raised from 63/80 once `simulateForDisplay` gained direct tests. It is
    // reachable in production only behind a signing request and a live
    // endpoint, so nothing else exercises its failure paths, and every field
    // it returns is endpoint-controlled text rendered to someone deciding
    // whether to sign.
    'src/stellar/soroban.ts': { branches: 75, lines: 86 },
    'src/ui/format.ts': { branches: 83, lines: 95 },
    'src/ui/transaction.tsx': { branches: 65, lines: 75 },
  },
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
