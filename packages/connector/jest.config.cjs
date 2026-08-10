module.exports = {
  testEnvironment: 'node',
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
