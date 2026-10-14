module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '.*\.int\.spec\.ts$',
  testTimeout: 90000,
  maxWorkers: 1,
  // BullMQ keeps sockets open briefly after close(); all servers are closed explicitly in afterAll.
  forceExit: true,
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }] },
};
