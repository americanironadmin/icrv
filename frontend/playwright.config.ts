import { defineConfig } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.csp-walk.env') });

// Walk target. The default points at the per-deployment unique-hash Pages URL,
// which serves the same _headers (and therefore the same CSP) as the production
// custom domain icrv.americanironus.com but is NOT covered by the Cloudflare
// Access Application's destination rules (Access matches exact hostnames, so
// `<hash>.icrv-dashboard.pages.dev` slips through). This lets the walk hit a
// real CSP-bearing response without needing a service token.
//
// Override with PLAYWRIGHT_TEST_BASE_URL to walk a different deployment.
const SITE = process.env.PLAYWRIGHT_TEST_BASE_URL ?? 'https://icrv.americanironus.com';

const useAccessHeaders = !!(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET);

export default defineConfig({
  testDir: './scripts',
  testMatch: 'csp-walk.spec.ts',
  timeout: 120_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: SITE,
    headless: true,
    extraHTTPHeaders: useAccessHeaders
      ? {
          'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID!,
          'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET!,
        }
      : undefined,
    ignoreHTTPSErrors: false,
  },
});
