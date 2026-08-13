module.exports = {
  testEnvironment: 'node',
  // The connector is plain TypeScript with no runtime dependencies and no
  // snap sandbox, so unlike the snap package (see its jest.config.js) these
  // numbers mean what they say: every module runs in process.
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
  ],
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageDirectory: 'coverage',
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
