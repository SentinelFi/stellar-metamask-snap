module.exports = {
  testEnvironment: 'node',
  // The connector is plain TypeScript with no runtime dependencies and no
  // snap sandbox, so unlike the snap package (see its jest.config.js) these
  // numbers mean what they say: every module runs in process.
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
    // Pure re-exports; nothing executable to cover.
    '!src/index.ts',
  ],
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageDirectory: 'coverage',
  // Source imports carry explicit .js extensions (native-ESM emit); tests
  // run against the .ts sources, so strip the extension for resolution.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // The connector is the audited trust boundary between dapps and the snap;
  // its behavior must stay under test. Thresholds gate CI via test:coverage.
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 90,
      lines: 90,
      statements: 90,
    },
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
        },
      },
    ],
  },
};
