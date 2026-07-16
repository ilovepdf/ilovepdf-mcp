/* eslint-disable no-console -- this suite exercises the stdout guard, so it
   must call the very console methods (log/info/debug) the guard rebinds. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockdownStdout } from '../../src/lib/stdout-guard.js';

/**
 * LOG-3: on the MCP stdio transport, `process.stdout` carries protocol frames.
 * A stray `console.log` corrupts that stream. `lockdownStdout()` must rebind
 * `console.log`/`.info`/`.debug` to route through `console.error` (stderr) while
 * leaving `process.stdout.write` UNTOUCHED.
 */
describe('lockdownStdout', () => {
  // Snapshot the originals so every test restores a clean console afterward,
  // preventing this suite from polluting others that spy on console methods.
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    error: console.error,
  };

  afterEach(() => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.error = original.error;
    vi.restoreAllMocks();
  });

  it('routes console.log through console.error (stderr)', () => {
    lockdownStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    console.log('hello', 42);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('hello', 42);
  });

  it('routes console.info and console.debug through console.error (stderr)', () => {
    lockdownStdout();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    console.info('info-msg');
    console.debug('debug-msg');

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenNthCalledWith(1, 'info-msg');
    expect(errorSpy).toHaveBeenNthCalledWith(2, 'debug-msg');
  });

  it('does NOT write to real stdout when console.log is called', () => {
    lockdownStdout();
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    console.log('should-not-hit-stdout');

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('leaves process.stdout.write untouched (same reference)', () => {
    const before = process.stdout.write;

    lockdownStdout();

    expect(process.stdout.write).toBe(before);
  });
});
