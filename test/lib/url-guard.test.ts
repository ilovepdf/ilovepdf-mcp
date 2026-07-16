/**
 * test/lib/url-guard.test.ts
 *
 * Unit tests for the network-egress SSRF guard (lib/url-guard.ts).
 *
 * Coverage (SSRF-1..SSRF-4):
 * - SSRF-1: Only http/https schemes are accepted; file:/ftp:/data: are rejected.
 * - SSRF-2: IP-literal hosts in blocked ranges (loopback, private, link-local,
 *   metadata, unspecified) are denied without any DNS lookup.
 * - SSRF-3: A hostname that resolves (mocked via the `resolve` option) to a
 *   private IP is denied even though the hostname itself looks public.
 * - SSRF-4: `safeFetch` re-validates every redirect Location before following;
 *   a redirect to a blocked address causes a VALIDATION_ERROR without the
 *   request reaching the internal address.
 *
 * DNS is NEVER hit for real: SSRF-2 uses IP-literal URLs (no lookup needed),
 * SSRF-3 injects a custom `resolve` function, and SSRF-4 stubs global `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertUrlAllowed, assertUrlPrecheck, safeFetch } from '../../src/lib/url-guard.js';
import { isToolError } from '../../src/domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the promise rejects with a ToolError('VALIDATION_ERROR', …). */
async function expectValidationError(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR'
  );
}

/** Build a resolve function that always returns the given addresses. */
function fixedResolve(addresses: string[]) {
  return vi.fn(async (_hostname: string) => addresses);
}

// ---------------------------------------------------------------------------
// SSRF-1 — Scheme check
// ---------------------------------------------------------------------------

describe('assertUrlAllowed — SSRF-1: scheme check', () => {
  it('accepts a public https URL with an IP literal (no DNS needed)', async () => {
    // 1.2.3.4 is a public address; IP literal avoids real DNS in the test.
    await expect(
      assertUrlAllowed('https://1.2.3.4/file.pdf')
    ).resolves.toBeUndefined();
  });

  it('accepts a public http URL with an IP literal', async () => {
    await expect(
      assertUrlAllowed('http://1.2.3.4/file.pdf')
    ).resolves.toBeUndefined();
  });

  it('accepts a public https URL with a hostname (via injected resolve)', async () => {
    await expect(
      assertUrlAllowed('https://example.com/report.pdf', {
        resolve: fixedResolve(['93.184.216.34']),
      })
    ).resolves.toBeUndefined();
  });

  it('rejects file: scheme → VALIDATION_ERROR (SSRF-1)', async () => {
    await expectValidationError(assertUrlAllowed('file:///etc/passwd'));
  });

  it('rejects ftp: scheme → VALIDATION_ERROR (SSRF-1)', async () => {
    await expectValidationError(assertUrlAllowed('ftp://example.com/file.pdf'));
  });

  it('rejects data: scheme → VALIDATION_ERROR (SSRF-1)', async () => {
    await expectValidationError(
      assertUrlAllowed('data:text/plain;base64,SGVsbG8=')
    );
  });
});

// ---------------------------------------------------------------------------
// SSRF-2 — IP-literal range checks (no DNS)
// ---------------------------------------------------------------------------

describe('assertUrlAllowed — SSRF-2: IP-literal range checks', () => {
  it('rejects loopback 127.0.0.1 → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://127.0.0.1/internal'));
  });

  it('rejects loopback 127.x.x.x (any /8) → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://127.99.1.1/path'));
  });

  it('rejects IPv6 loopback ::1 → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://[::1]/internal'));
  });

  it('rejects private 10.0.0.5 → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://10.0.0.5/internal'));
  });

  it('rejects private 192.168.1.1 → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://192.168.1.1/internal'));
  });

  it('rejects private 172.16.0.1 (172.16/12) → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://172.16.0.1/internal'));
  });

  it('rejects private 172.31.255.255 (upper edge of 172.16/12) → VALIDATION_ERROR', async () => {
    await expectValidationError(
      assertUrlAllowed('http://172.31.255.255/internal')
    );
  });

  it('allows 172.32.0.1 (just outside 172.16/12)', async () => {
    await expect(
      assertUrlAllowed('http://172.32.0.1/path')
    ).resolves.toBeUndefined();
  });

  it('rejects link-local / cloud metadata 169.254.169.254 → VALIDATION_ERROR', async () => {
    await expectValidationError(
      assertUrlAllowed('http://169.254.169.254/latest/meta-data/')
    );
  });

  it('rejects any 169.254.x.x (link-local /16) → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://169.254.0.1/path'));
  });

  it('rejects unspecified 0.0.0.0 → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://0.0.0.0/internal'));
  });
});

// ---------------------------------------------------------------------------
// SSRF-3 — DNS-resolved IP check (via injected resolver)
// ---------------------------------------------------------------------------

describe('assertUrlAllowed — SSRF-3: DNS-resolved IP check', () => {
  it('rejects a hostname resolving to a private IPv4 → VALIDATION_ERROR', async () => {
    const resolve = fixedResolve(['192.168.1.10']);
    await expectValidationError(
      assertUrlAllowed('https://looks-public.example.com/file.pdf', { resolve })
    );
    // Resolver was called with the correct hostname.
    expect(resolve).toHaveBeenCalledWith('looks-public.example.com');
  });

  it('rejects a hostname resolving to the metadata IP → VALIDATION_ERROR', async () => {
    const resolve = fixedResolve(['169.254.169.254']);
    await expectValidationError(
      assertUrlAllowed('https://evil.example.com/x', { resolve })
    );
  });

  it('allows a hostname resolving to a public IP', async () => {
    await expect(
      assertUrlAllowed('https://example.com/file.pdf', {
        resolve: fixedResolve(['93.184.216.34']),
      })
    ).resolves.toBeUndefined();
  });

  it('rejects when ANY resolved address is in a blocked range (multi-address)', async () => {
    // First address is public, second is loopback — should still be denied.
    const resolve = fixedResolve(['93.184.216.34', '127.0.0.1']);
    await expectValidationError(
      assertUrlAllowed('https://tricky.example.com/x', { resolve })
    );
  });
});

// ---------------------------------------------------------------------------
// SSRF-2 (extended) — IPv4-mapped / IPv4-compatible / NAT64 bypass
// ---------------------------------------------------------------------------

describe('assertUrlAllowed — SSRF-2 (extended): IPv4-mapped, IPv4-compatible, NAT64', () => {
  it('rejects IPv4-mapped loopback [::ffff:127.0.0.1] → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://[::ffff:127.0.0.1]/'));
  });

  it('rejects IPv4-mapped link-local [::ffff:169.254.169.254] → VALIDATION_ERROR', async () => {
    await expectValidationError(
      assertUrlAllowed('http://[::ffff:169.254.169.254]/latest/meta-data/')
    );
  });

  it('rejects IPv4-mapped private [::ffff:10.0.0.5] → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://[::ffff:10.0.0.5]/'));
  });

  it('rejects IPv4-mapped unspecified [::ffff:0.0.0.0] → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://[::ffff:0.0.0.0]/'));
  });

  it('rejects IPv4-compatible loopback [::7f00:1] → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://[::7f00:1]/'));
  });

  it('rejects NAT64 [64:ff9b::7f00:1] → VALIDATION_ERROR', async () => {
    await expectValidationError(assertUrlAllowed('http://[64:ff9b::7f00:1]/'));
  });

  it('allows a fully-public IPv6 address [2606:4700:4700::1111] → not blocked', async () => {
    await expect(
      assertUrlAllowed('http://[2606:4700:4700::1111]/')
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// assertUrlPrecheck — lightweight precheck (SSRF-6, no DNS, E3 regression)
// ---------------------------------------------------------------------------

describe('assertUrlPrecheck — IPv4-mapped IPv6 dotted-quad (E3 fix)', () => {
  /** assertUrlPrecheck is synchronous — wrap in Promise.resolve for the helper. */
  async function expectPrecheckValidationError(rawUrl: string): Promise<void> {
    await expectValidationError(
      Promise.resolve().then(() => assertUrlPrecheck(rawUrl))
    );
  }

  it('rejects IPv4-mapped link-local [::ffff:169.254.169.254] → VALIDATION_ERROR', async () => {
    // Bug E3: net.isIPv6("::ffff:169.254.169.254") may return false for the
    // mixed dotted-quad notation, causing the IPv6 branch to be skipped and
    // the URL to pass the precheck. The fix uses hostname.includes(':').
    await expectPrecheckValidationError('http://[::ffff:169.254.169.254]/');
  });

  it('rejects IPv4-mapped loopback [::ffff:127.0.0.1] → VALIDATION_ERROR', async () => {
    await expectPrecheckValidationError('http://[::ffff:127.0.0.1]/');
  });

  it('rejects IPv4-compatible loopback [::127.0.0.1] → VALIDATION_ERROR', async () => {
    await expectPrecheckValidationError('http://[::127.0.0.1]/');
  });

  it('allows a public IPv6 literal [2606:4700:4700::1111] → no error', () => {
    // Cloudflare DNS over IPv6 — must pass the precheck so public IPv6 URLs work.
    expect(() => assertUrlPrecheck('http://[2606:4700:4700::1111]/')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SSRF-4 — safeFetch redirect re-validation
// ---------------------------------------------------------------------------

describe('safeFetch — SSRF-4: redirect re-validation', () => {
  beforeEach(() => {
    // Each test in this group stubs the global fetch itself.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a redirect to a blocked IP address → VALIDATION_ERROR, no request reaches it', async () => {
    // Initial URL is a public IP literal (no DNS needed), so assertUrlAllowed passes.
    // The mocked fetch returns a 301 to the cloud-metadata address.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expectValidationError(safeFetch('https://1.2.3.4/file.pdf'));

    // The internal address was never fetched — fetchMock called only once (initial).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://1.2.3.4/file.pdf');
  });

  it('rejects a redirect to a private IP → VALIDATION_ERROR', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://192.168.1.1/secret' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expectValidationError(safeFetch('https://1.2.3.4/doc.pdf'));
  });

  it('follows a safe redirect (public → public) and returns the final response', async () => {
    const finalResponse = new Response('file contents', { status: 200 });
    const fetchMock = vi
      .fn()
      // First call: redirect to another public IP.
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://5.6.7.8/file.pdf' },
        })
      )
      // Second call: final response.
      .mockResolvedValueOnce(finalResponse);
    vi.stubGlobal('fetch', fetchMock);

    const res = await safeFetch('https://1.2.3.4/file.pdf');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a non-redirect response directly', async () => {
    const ok = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok));

    const res = await safeFetch('https://1.2.3.4/file.pdf');
    expect(res.status).toBe(200);
  });

  it('fetches with redirect:manual so the platform never auto-follows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('https://1.2.3.4/file.pdf');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init?.redirect).toBe('manual');
  });
});
