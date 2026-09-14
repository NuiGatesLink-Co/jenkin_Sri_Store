import { hasWindowsLoopbackCrashBug } from './windows-node-check.js';

describe('hasWindowsLoopbackCrashBug (#160)', () => {
  it.each([
    ['v22.23.2', true],
    ['v24.15.0', true],
    ['v24.16.0', false],
    ['v24.21.0', false],
    ['v25.9.0', true],
    ['v26.0.0', true],
    ['v26.1.0', false],
    ['v27.0.0', false],
    ['not-a-version', false],
  ])('%s → %s', (version, expected) => {
    expect(hasWindowsLoopbackCrashBug(version)).toBe(expected);
  });
});
