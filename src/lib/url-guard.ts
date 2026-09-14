/**
 * lib/url-guard.ts (NEW leaf — DEC-3, specs/network-egress-ssrf.md)
 *
 * Network-egress / SSRF guard. Applies a deny-by-default policy to every URL
 * this server dereferences directly, covering:
 *
 *   SSRF-1 — Only `http` and `https` URL schemes are accepted.
 *   SSRF-2 — IP-literal hosts in blocked ranges (loopback / private /
 *             link-local / metadata / unspecified) are denied WITHOUT any DNS
 *             lookup.
 *   SSRF-3 — Hostnames are DNS-resolved; if any resolved address falls in a
 *             blocked range the URL is denied (decoy-hostname / rebinding
 *             defence).
 *   SSRF-4 — `safeFetch` re-validates every HTTP redirect Location before
 *             following so a redirect cannot lead to a blocked address.
 *
 * Additionally exports `assertUrlPrecheck(url)` — a lightweight variant that
 * only applies SSRF-1 + the IP-literal part of SSRF-2. Used for delegated
 * cloud-upload URLs (SSRF-6) where DNS resolution is iLovePDF's responsibility.
 *
 * Imports ONLY Node built-ins (`node:dns`, `node:net`) and
 * `src/domain/errors.ts`. Denials always surface as
 * `ToolError('VALIDATION_ERROR', …)`.
 */

import { isIPv4, isIPv6 } from 'node:net';
import { promises as dnsPromises } from 'node:dns';
import { ToolError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// IPv4 blocked-range classification (SSRF-2)
// ---------------------------------------------------------------------------

/** Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer. */
function ipv4ToUint32(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number);
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

/**
 * Return true if the IPv4 address falls in any deny-by-default blocked range:
 * - Unspecified: 0.0.0.0
 * - Loopback:    127.0.0.0/8
 * - Private:     10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Link-local:  169.254.0.0/16  (includes the cloud-metadata endpoint)
 */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToUint32(ip);
  /* 0.0.0.0 — unspecified */
  if (n === 0) return true;
  /* 127.0.0.0/8 — loopback */
  if ((n >>> 24) === 127) return true;
  /* 10.0.0.0/8 — private */
  if ((n >>> 24) === 10) return true;
  /* 172.16.0.0/12 — private (top 12 bits = 0xAC1) */
  if ((n >>> 20) === 0xac1) return true;
  /* 192.168.0.0/16 — private */
  if ((n >>> 16) === ((192 << 8) | 168)) return true;
  /* 169.254.0.0/16 — link-local + cloud metadata */
  if ((n >>> 16) === ((169 << 8) | 254)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// IPv6 blocked-range classification (SSRF-2)
// ---------------------------------------------------------------------------

/**
 * Expand an IPv6 address string (WITHOUT brackets) to its canonical 16-byte
 * representation. Handles `::` shorthand and embedded IPv4 dotted-quad tails
 * (e.g. `::ffff:127.0.0.1` — the dotted quad is NOT hex and must not be
 * parsed with `parseInt(…, 16)`).
 */
function ipv6ToBytes(addr: string): Uint8Array {
  const bytes = new Uint8Array(16);

  // Detect an embedded IPv4 dotted-quad tail (e.g. "::ffff:127.0.0.1").
  // Greedy match: the last colon-separated token may be a.b.c.d notation.
  const ipv4Match = addr.match(/^(.*):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);

  let hexAddr: string;
  let targetGroups: number;

  if (ipv4Match) {
    // The dotted-quad occupies bytes 12–15.
    const ipv4Parts = ipv4Match[2].split('.').map(Number);
    bytes[12] = ipv4Parts[0];
    bytes[13] = ipv4Parts[1];
    bytes[14] = ipv4Parts[2];
    bytes[15] = ipv4Parts[3];
    // A lone ":" prefix (from "::a.b.c.d") means all-zero (i.e., "::").
    hexAddr = ipv4Match[1] === ':' ? '::' : ipv4Match[1];
    targetGroups = 6; // hex portion covers bytes 0–11
  } else {
    hexAddr = addr;
    targetGroups = 8;
  }

  // Expand the hex portion into targetGroups × 16-bit values.
  let groups: number[];
  if (!hexAddr || hexAddr === '::') {
    groups = Array<number>(targetGroups).fill(0);
  } else if (hexAddr.includes('::')) {
    const halves = hexAddr.split('::');
    const left = halves[0] ? halves[0].split(':').map(s => parseInt(s, 16)) : [];
    const right = halves[1] ? halves[1].split(':').map(s => parseInt(s, 16)) : [];
    const pad = Math.max(0, targetGroups - left.length - right.length);
    groups = [...left, ...Array<number>(pad).fill(0), ...right];
  } else {
    groups = hexAddr.split(':').map(s => parseInt(s || '0', 16));
  }

  for (let i = 0; i < targetGroups; i++) {
    bytes[i * 2] = ((groups[i] ?? 0) >> 8) & 0xff;
    bytes[i * 2 + 1] = (groups[i] ?? 0) & 0xff;
  }

  return bytes;
}

/**
 * Return true if the IPv6 address (without brackets) falls in any blocked
 * range:
 * - Unspecified:      ::              (all zeros)
 * - Loopback:         ::1
 * - ULA private:      fc00::/7        (first byte 0xFC or 0xFD)
 * - Link-local:       fe80::/10       (first byte 0xFE, second byte MSBs = 10)
 * - IPv4-mapped:      ::ffff:0:0/96   (entire range blocked; SSRF via IPv4-in-IPv6)
 * - IPv4-compatible:  ::x.x.x.x       (bytes 0–11 zero; run embedded IP through isBlockedIpv4)
 * - NAT64:            64:ff9b::/96    (entire range blocked; translates IPv6→IPv4 traffic)
 */
function isBlockedIpv6(addr: string): boolean {
  const b = ipv6ToBytes(addr);

  /* :: — unspecified (all bytes zero) */
  if (b.every(byte => byte === 0)) return true;

  /* ::1 — loopback */
  if (b.slice(0, 15).every(byte => byte === 0) && b[15] === 1) return true;

  /* fc00::/7 — ULA private (first byte is 0xFC or 0xFD) */
  if ((b[0] & 0xfe) === 0xfc) return true;

  /* fe80::/10 — link-local (first byte 0xFE, second byte high two bits = 10) */
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;

  /* ::ffff:0:0/96 — IPv4-mapped range (bytes 0–9 = 0, bytes 10–11 = 0xff).
   * Block the entire /96 outright: an attacker can embed any IPv4 address
   * (private OR public) behind this prefix to bypass the IPv4 range checks. */
  if (
    b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 &&
    b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
    b[8] === 0 && b[9] === 0 &&
    b[10] === 0xff && b[11] === 0xff
  ) {
    return true;
  }

  /* ::x.x.x.x — IPv4-compatible (bytes 0–11 all zero, non-zero IPv4 tail).
   * Extract the embedded IPv4 address and run it through isBlockedIpv4. */
  if (
    b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 &&
    b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
    b[8] === 0 && b[9] === 0 && b[10] === 0 && b[11] === 0 &&
    (b[12] !== 0 || b[13] !== 0 || b[14] !== 0 || b[15] !== 0)
  ) {
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  /* 64:ff9b::/96 — NAT64 prefix (block the entire range; translates IPv6
   * requests to IPv4 destinations, defeating the blocked-range check). */
  if (
    b[0] === 0x00 && b[1] === 0x64 &&
    b[2] === 0xff && b[3] === 0x9b &&
    b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
    b[8] === 0 && b[9] === 0 && b[10] === 0 && b[11] === 0
  ) {
    return true;
  }

  return false;
}

/** Return true if the given IP string (v4 or v6, no brackets) is blocked. */
function isBlockedAddress(addr: string): boolean {
  if (isIPv4(addr)) return isBlockedIpv4(addr);
  if (isIPv6(addr)) return isBlockedIpv6(addr);
  return false;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `assertUrlAllowed`. Inject `resolve` in tests to avoid real DNS
 * lookups; production code uses the built-in `dns.promises.lookup`.
 */
export interface AssertUrlAllowedOptions {
  resolve?: (hostname: string) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Scheme check (shared between full and pre-check variants)
// ---------------------------------------------------------------------------

/**
 * Parse the URL and throw if the scheme is not `http:` or `https:`.
 * Returns the parsed URL on success (SSRF-1).
 */
function parseAndCheckScheme(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ToolError(
      'VALIDATION_ERROR',
      `Invalid URL: "${rawUrl}".`,
      'The provided URL is invalid.',
      false
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError(
      'VALIDATION_ERROR',
      `Blocked URL scheme "${parsed.protocol}" in "${rawUrl}".`,
      'Only http and https URLs are accepted.',
      false
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// assertUrlAllowed — full SSRF-1 + SSRF-2 + SSRF-3 check
// ---------------------------------------------------------------------------

/**
 * Validate a URL before making any outbound request. Throws
 * `ToolError('VALIDATION_ERROR', …)` when:
 *   - The scheme is not `http` or `https` (SSRF-1).
 *   - The host is an IP literal in a blocked range (SSRF-2).
 *   - The host is a hostname that resolves to a blocked address (SSRF-3).
 *
 * Resolves to `undefined` when the URL passes all checks.
 *
 * @param rawUrl The URL to validate.
 * @param opts   Optional: inject a mock `resolve` for tests (defaults to
 *               `dns.promises.lookup`).
 */
export async function assertUrlAllowed(
  rawUrl: string,
  opts: AssertUrlAllowedOptions = {}
): Promise<void> {
  const parsed = parseAndCheckScheme(rawUrl);

  // URL.hostname returns IPv6 literals WITH surrounding brackets on all
  // platforms (e.g. "[::1]", "[2606:4700:4700::1111]"). net.isIPv6 / net.isIP
  // do not recognize the bracketed form, so a bracketed literal would fall
  // through to dns.lookup — which behaves differently per OS (Linux may fail
  // to resolve the bracketed string, causing a spurious VALIDATION_ERROR for
  // public addresses). Strip brackets first so IP-literal detection is
  // platform-deterministic and no DNS lookup is ever made for IP literals.
  const rawHostname = parsed.hostname;
  const hostname =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

  if (isIPv4(hostname)) {
    // SSRF-2: IPv4 literal — no DNS needed.
    if (isBlockedIpv4(hostname)) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Blocked IPv4 address "${hostname}" in "${rawUrl}".`,
        'The URL points to a restricted network address.',
        false
      );
    }
  } else if (isIPv6(hostname) || hostname.includes(':')) {
    // SSRF-2: IPv6 literal (brackets stripped above). The `hostname.includes(':')`
    // guard catches mixed dotted-quad notation such as "::ffff:169.254.169.254"
    // that net.isIPv6 may not recognize, consistent with assertUrlPrecheck.
    if (isBlockedIpv6(hostname)) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Blocked IPv6 address "${hostname}" in "${rawUrl}".`,
        'The URL points to a restricted network address.',
        false
      );
    }
  } else {
    // SSRF-3: hostname — resolve and check every returned address.
    const resolve = opts.resolve ?? defaultResolve;
    let addresses: string[];
    try {
      addresses = await resolve(hostname);
    } catch {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Could not resolve hostname "${hostname}" in "${rawUrl}".`,
        'The provided hostname could not be resolved.',
        false
      );
    }
    for (const addr of addresses) {
      if (isBlockedAddress(addr)) {
        throw new ToolError(
          'VALIDATION_ERROR',
          `Hostname "${hostname}" resolves to blocked address "${addr}" in "${rawUrl}".`,
          'The URL points to a restricted network address.',
          false
        );
      }
    }
  }
}

/**
 * Default DNS resolver: uses `dns.promises.lookup` requesting ALL addresses so
 * a multi-homed host cannot sneak a private address past the check.
 */
async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await dnsPromises.lookup(hostname, { all: true });
  return results.map(r => r.address);
}

// ---------------------------------------------------------------------------
// assertUrlPrecheck — lightweight SSRF-1 + IP-literal SSRF-2 only (SSRF-6)
// ---------------------------------------------------------------------------

/**
 * Lightweight pre-check for URLs that will be delegated to an upstream service
 * rather than fetched by this server (SSRF-6). Only validates:
 *   - Scheme is `http` or `https` (SSRF-1).
 *   - If the host is an IP literal, it must not be in a blocked range (SSRF-2).
 *
 * Hostnames are NOT DNS-resolved (the upstream service owns that check).
 * Throws `ToolError('VALIDATION_ERROR', …)` on failure.
 *
 * E3 FIX: uses `hostname.includes(':')` rather than `net.isIPv6(hostname)` to
 * detect IPv6 literals, because `net.isIPv6()` returns `false` for the mixed
 * dotted-quad notation (e.g. `::ffff:169.254.169.254`) accepted by the URL
 * parser. `ipv6ToBytes` already handles both pure-hex and mixed-notation forms
 * correctly, so routing through `isBlockedIpv6` is safe for any `:` hostname.
 */
export function assertUrlPrecheck(rawUrl: string): void {
  const parsed = parseAndCheckScheme(rawUrl);

  // Strip surrounding brackets from IPv6 literals (same rationale as
  // assertUrlAllowed — URL.hostname returns "[::1]" WITH brackets on all
  // platforms; strip them so isIPv4 / includes(':') classify the host correctly).
  const rawHostname = parsed.hostname;
  const hostname =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

  if (isIPv4(hostname)) {
    if (isBlockedIpv4(hostname)) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Blocked IPv4 address "${hostname}" in delegated URL "${rawUrl}".`,
        'The URL points to a restricted network address.',
        false
      );
    }
  } else if (hostname.includes(':')) {
    // Any colon in the (bracket-stripped) hostname means it is an IPv6 literal
    // — pure-hex OR mixed dotted-quad notation. Route through isBlockedIpv6
    // (which delegates to ipv6ToBytes) so both notations are classified
    // correctly without relying on net.isIPv6().
    if (isBlockedIpv6(hostname)) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Blocked IPv6 address "${hostname}" in delegated URL "${rawUrl}".`,
        'The URL points to a restricted network address.',
        false
      );
    }
  }
}

// ---------------------------------------------------------------------------
// safeFetch — fetch with SSRF guard + redirect re-validation (SSRF-4)
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 10;

/**
 * Options for `safeFetch`. All fields are optional.
 */
export interface SafeFetchOptions {
  /**
   * If provided, every URL in the redirect chain (including the initial URL)
   * must pass this predicate. The hostname (brackets already stripped by the
   * URL parser) is passed as the argument; returning `false` causes a
   * `ToolError('VALIDATION_ERROR', …)` before any request is made to that URL.
   *
   * Use this to enforce a host allow-list (e.g. `.ilovepdf.com` suffix check)
   * across the entire redirect chain so that a malicious 3xx response from an
   * allowed server cannot redirect to an arbitrary host (SSRF-5 / SSRF-4).
   */
  allowHost?: (host: string) => boolean;
}

/**
 * Validate `url` with the full SSRF guard, then fetch it with
 * `redirect:'manual'`. For every 3xx response, re-validate the `Location`
 * header target before following. A redirect to a blocked address throws
 * `ToolError('VALIDATION_ERROR', …)` (SSRF-4) without the request reaching
 * the internal address.
 *
 * When `opts.allowHost` is supplied it is also checked against every URL in
 * the chain (initial + redirects), so a redirect cannot escape the declared
 * host allow-list even if the target passes the SSRF range checks (SSRF-5).
 *
 * Use this as the safe drop-in replacement for raw `fetch` wherever this
 * server initiates a network request itself (e.g. the result download in
 * `core/result-builder.ts`).
 *
 * @throws ToolError('VALIDATION_ERROR') if any URL in the redirect chain fails
 *         the SSRF guard, the host allow-list, or the redirect limit.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  opts?: SafeFetchOptions
): Promise<Response> {
  return safeFetchInternal(url, init, opts ?? {}, 0);
}

async function safeFetchInternal(
  url: string,
  init: RequestInit | undefined,
  opts: SafeFetchOptions,
  redirectCount: number
): Promise<Response> {
  if (redirectCount > MAX_REDIRECTS) {
    throw new ToolError(
      'VALIDATION_ERROR',
      `Too many redirects (>${MAX_REDIRECTS}) starting from "${url}".`,
      'The server redirected too many times.',
      false
    );
  }

  // Full SSRF check (SSRF-1 + SSRF-2 + SSRF-3) before any network contact.
  await assertUrlAllowed(url);

  // Apply the caller-supplied host allow-list predicate (SSRF-5 / SSRF-4).
  // Checked on EVERY URL in the chain (initial + all redirects) so that a
  // malicious 3xx cannot redirect to a host outside the allow-list.
  if (opts.allowHost) {
    let parsedForHost: URL;
    try {
      parsedForHost = new URL(url);
    } catch {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Invalid URL: "${url}".`,
        'The provided URL is invalid.',
        false
      );
    }
    if (!opts.allowHost(parsedForHost.hostname)) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `URL host "${parsedForHost.hostname}" is not in the allowed host list.`,
        'The URL is not on an allowed server.',
        false
      );
    }
  }

  const res = await fetch(url, { ...init, redirect: 'manual' });

  // Manually follow redirects so each Location is re-validated (SSRF-4).
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Redirect from "${url}" had no Location header (status ${res.status}).`,
        'The server returned an invalid redirect.',
        false
      );
    }
    // Resolve relative Location values against the current URL.
    const redirectUrl = new URL(location, url).toString();
    return safeFetchInternal(redirectUrl, init, opts, redirectCount + 1);
  }

  return res;
}
