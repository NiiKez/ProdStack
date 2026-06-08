import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// H1 security review finding: the public web origin (prodstack-web / nginx) must
// ship security response headers on the HTML document AND the hashed assets — the
// backend helmet CSP only covers API JSON responses, never the page the browser
// renders. These tests pin the nginx config so a regression (dropping a header, or
// adding a location-level add_header without re-including the snippet) is caught.
//
// frontend/ is the vitest rootDir; the configs sit at the workspace root.
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = readFileSync(
  path.join(FRONTEND_ROOT, 'nginx.conf.template'),
  'utf8'
);
const SNIPPET = readFileSync(
  path.join(FRONTEND_ROOT, 'nginx.security-headers.conf'),
  'utf8'
);

const SNIPPET_INCLUDE = 'include /etc/nginx/snippets/prodstack-security-headers.conf;';

/**
 * Every `location ... { ... }` body, captured brace-balanced so a location whose
 * body NESTS a block (`if (...) {}`, `limit_except {}`) is read in full. A flat
 * single-level regex (`\{([^{}]*)\}`) would stop at the first inner `}` and
 * silently skip the rest of such a location — letting an `add_header` inside it
 * escape the snippet check, the exact regression this test guards. Line comments
 * are stripped first so the word "location" inside a `#` comment isn't matched.
 */
function locationBodies(config: string): string[] {
  const src = config.replace(/#[^\n]*/g, '');
  const bodies: string[] = [];
  const re = /\blocation\b[^{]*\{/g;
  // exec advances re.lastIndex past the matched `location ... {`; we read that,
  // not the match object, so the boolean result is all we need from exec.
  while (re.exec(src) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    const bodyStart = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    bodies.push(src.slice(bodyStart, i - 1));
  }
  return bodies;
}

describe('nginx security-headers snippet', () => {
  it('disables server_tokens (no nginx version leak)', () => {
    expect(SNIPPET).toMatch(/^\s*server_tokens off;/m);
  });

  it('sets every required security header with `always`', () => {
    const required = [
      'Content-Security-Policy',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Strict-Transport-Security',
      'Permissions-Policy',
    ];
    for (const header of required) {
      // add_header "<Header>" "..." always;
      const re = new RegExp(
        `add_header\\s+${header}\\s+"[^"]+"\\s+always;`,
        'i'
      );
      expect(SNIPPET, `missing always-header: ${header}`).toMatch(re);
    }
  });

  it('uses the documented hardened header values', () => {
    expect(SNIPPET).toMatch(/X-Frame-Options\s+"DENY"\s+always;/);
    expect(SNIPPET).toMatch(/X-Content-Type-Options\s+"nosniff"\s+always;/);
    expect(SNIPPET).toMatch(
      /Referrer-Policy\s+"strict-origin-when-cross-origin"\s+always;/
    );
    // HSTS: 1 year + subdomains (HTTPS-only behind Azure Container Apps ingress).
    expect(SNIPPET).toMatch(
      /Strict-Transport-Security\s+"max-age=31536000; includeSubDomains"\s+always;/
    );
    // Restrictive Permissions-Policy default.
    expect(SNIPPET).toMatch(/Permissions-Policy\s+"[^"]*camera=\(\)[^"]*"\s+always;/);
  });
});

describe('Content-Security-Policy', () => {
  // Pull the CSP value out of the snippet for fine-grained assertions.
  const cspMatch = SNIPPET.match(/Content-Security-Policy\s+"([^"]+)"\s+always;/);
  const csp = cspMatch?.[1] ?? '';

  it('is present', () => {
    expect(csp).not.toBe('');
  });

  it('locks the default and object sources', () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('blocks framing via frame-ancestors none', () => {
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("does NOT weaken script-src with 'unsafe-eval' or 'unsafe-inline'", () => {
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src'));
    expect(scriptSrc, 'script-src directive missing').toBeTruthy();
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it("allows 'unsafe-inline' ONLY in style-src (Radix UI inline positioning styles)", () => {
    const styleSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('style-src'));
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it('allows GitHub avatars + data URIs in img-src, keeps connect/font self', () => {
    expect(csp).toContain('img-src');
    expect(csp).toContain('https://avatars.githubusercontent.com');
    expect(csp).toContain('data:');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("font-src 'self'");
  });
});

describe('nginx.conf.template wiring (location inheritance gotcha)', () => {
  it('includes the security snippet at the server level', () => {
    expect(TEMPLATE).toContain(SNIPPET_INCLUDE);
  });

  it('re-includes the snippet in EVERY location that sets its own add_header', () => {
    // nginx stops inheriting server-level add_header into a location that defines
    // its own. Find every such location block and assert the snippet is included
    // inside it — otherwise that response (SPA shell / hashed assets) ships naked.
    const locationBlocks = locationBodies(TEMPLATE);
    const blocksWithAddHeader = locationBlocks.filter((body) =>
      /\badd_header\b/.test(body)
    );
    // Sanity: the template has at least the /assets/ and /index.html blocks.
    expect(blocksWithAddHeader.length).toBeGreaterThanOrEqual(2);
    for (const body of blocksWithAddHeader) {
      expect(
        body,
        'a location sets add_header but does NOT re-include the security snippet — ' +
          'its responses would have no security headers'
      ).toContain(SNIPPET_INCLUDE);
    }
  });
});
