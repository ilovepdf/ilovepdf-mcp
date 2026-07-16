/**
 * stdout-guard — LOG-3 stdout isolation for the MCP stdio transport.
 *
 * On the stdio transport, `process.stdout` is reserved EXCLUSIVELY for MCP
 * protocol frames. A single stray `console.log` (from this code or any
 * dependency) interleaves plain text into that stream and corrupts the
 * JSON-RPC framing, breaking the client connection.
 *
 * `lockdownStdout()` is the runtime safety net (design §2.3 layer 2): it
 * rebinds the stdout-bound console methods (`log`/`info`/`debug`) to route
 * through `console.error` (stderr) so accidental logging is diverted off the
 * protocol channel. It deliberately does NOT touch `process.stdout.write` —
 * that is the very channel the transport needs.
 *
 * Authored fresh for the headless port (no source equivalent). Called once by
 * `index.ts` before the transport connects; kept as a testable leaf here.
 */

/* eslint-disable no-console -- this module IS the guard: rebinding the
   stdout-bound console methods is its entire purpose. */
export function lockdownStdout(): void {
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };

  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}
/* eslint-enable no-console */
