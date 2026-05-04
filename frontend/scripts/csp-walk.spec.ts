// frontend/scripts/csp-walk.spec.ts
//
// Headless walk of every authenticated SPA route + reachable modal, used to
// verify zero CSP violations before flipping `_headers` from
// `Content-Security-Policy-Report-Only` to enforcing.
//
// Auth: Cloudflare Access service token via CF-Access-Client-Id /
// CF-Access-Client-Secret (configured in playwright.config.ts via .csp-walk.env).
// Service-token JWTs don't carry an email matching a D1 user, so /v1/auth/me
// would 401 and AuthGate would render the sign-in panel — masking every route
// from CSP testing. We mock that one endpoint so AuthGate flips to 'authed'
// and the real routes render. Every other request hits the real network so
// resource loads, fonts, images, and api calls all exercise CSP for real.
//
// Violation collection — two channels:
//   1. browser console:  page.on('console') filtered for "refused to" /
//                        "content security policy"
//   2. /csp-report POST: page.on('request') captures the body of any POST to
//                        the worker's report endpoint
//
// Output: violations array dumped to scripts/csp-walk-results.json. If
// non-empty, also written human-readable to ../csp-violations.txt at repo root.

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Violation = {
  source: 'console' | 'csp-report';
  route: string;
  message?: string;
  body?: string;
};

const ROUTES = ['/', '/contacts', '/campaigns', '/ai', '/logs', '/calls', '/settings'] as const;

const MOCK_USER = {
  id: 'csp-walk-bot',
  email: 'csp-walk@internal',
  name: 'CSP Walk Bot',
  role: 'admin',
  active: 1,
};

test('CSP walk — every authenticated route + reachable modals', async ({ browser }) => {
  test.setTimeout(180_000);

  const violations: Violation[] = [];
  let currentRoute = '<init>';

  const context = await browser.newContext();

  // Mock /v1/auth/me so AuthGate flips authed; let everything else hit real network.
  await context.route('**/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: MOCK_USER }),
    });
  });

  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    // Real CSP blocks always include "Refused to ..." or "violates the
    // following Content Security Policy directive: ...". Filter out informational
    // advisories the browser emits in report-only mode (e.g.
    // "directive 'upgrade-insecure-requests' is ignored when delivered in a
    // report-only policy") — those go away the moment CSP is enforcing and are
    // not blocks.
    const isBlock = /refused to |violates the following content security policy/i.test(text);
    const isAdvisory = /is ignored when delivered/i.test(text);
    if (isBlock && !isAdvisory) {
      violations.push({ source: 'console', route: currentRoute, message: text });
      // eslint-disable-next-line no-console
      console.log(`[csp-violation] route=${currentRoute} console=${text}`);
    }
  });

  page.on('request', (req) => {
    const u = req.url();
    if (req.method() === 'POST' && /\/csp-report(\?|$)/.test(u)) {
      const body = req.postData() ?? '<no body>';
      violations.push({ source: 'csp-report', route: currentRoute, body });
      // eslint-disable-next-line no-console
      console.log(`[csp-violation] route=${currentRoute} csp-report=${body.slice(0, 400)}`);
    }
  });

  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[pageerror] route=${currentRoute} ${err.message}`);
  });

  for (const route of ROUTES) {
    currentRoute = route;
    // eslint-disable-next-line no-console
    console.log(`\n[walk] navigating to ${route}`);
    try {
      await page.goto(route, { waitUntil: 'networkidle', timeout: 30_000 });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[walk] goto ${route} timed out or errored: ${(err as Error).message}`);
    }
    // Extra settle time for deferred chunks / images / fonts.
    await page.waitForTimeout(2000);

    // Per-route modal probes. Each is best-effort — if the trigger isn't
    // present on the rendered page (e.g. no contacts, kill switch button
    // not in expected state), skip and continue.
    const modalProbes: { label: string; selector: string }[] = [];

    if (route === '/contacts') {
      modalProbes.push({ label: 'New Contact', selector: 'button:has-text("New Contact")' });
      modalProbes.push({ label: 'Bulk CSV',    selector: 'button:has-text("Bulk CSV")' });
    }
    if (route === '/ai') {
      modalProbes.push({ label: 'Kill Switch', selector: 'button:has-text("Kill Switch"), button:has-text("Re-enable Agent")' });
      modalProbes.push({ label: 'Reject Run',  selector: 'button:has-text("Reject")' });
    }

    for (const probe of modalProbes) {
      try {
        const trigger = page.locator(probe.selector).first();
        if (await trigger.count() === 0) {
          // eslint-disable-next-line no-console
          console.log(`[modal] ${probe.label} — trigger not found, skipping`);
          continue;
        }
        // eslint-disable-next-line no-console
        console.log(`[modal] ${probe.label} — clicking`);
        await trigger.click({ timeout: 3_000, trial: false }).catch(() => {});
        await page.waitForTimeout(1000);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`[modal] ${probe.label} — error: ${(err as Error).message}`);
      }
    }
  }

  // Final settle to flush any in-flight csp-report POSTs.
  await page.waitForTimeout(2000);

  await context.close();

  const resultsPath = path.resolve(__dirname, 'csp-walk-results.json');
  const reportSummary = {
    timestamp: new Date().toISOString(),
    routes: ROUTES,
    violationCount: violations.length,
    violations,
  };
  fs.writeFileSync(resultsPath, JSON.stringify(reportSummary, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\n[walk] wrote results to ${resultsPath}`);

  if (violations.length > 0) {
    const txtPath = path.resolve(__dirname, '..', '..', 'csp-violations.txt');
    const lines: string[] = [
      `CSP walk found ${violations.length} violation(s) at ${new Date().toISOString()}`,
      '',
    ];
    for (const v of violations) {
      lines.push(`---`);
      lines.push(`source: ${v.source}`);
      lines.push(`route:  ${v.route}`);
      if (v.message) lines.push(`console: ${v.message}`);
      if (v.body) lines.push(`csp-report body: ${v.body}`);
    }
    fs.writeFileSync(txtPath, lines.join('\n') + '\n');
    // eslint-disable-next-line no-console
    console.log(`[walk] wrote human-readable violations to ${txtPath}`);
  }

  expect(violations, `CSP walk surfaced ${violations.length} violation(s); see csp-walk-results.json`).toEqual([]);
});
