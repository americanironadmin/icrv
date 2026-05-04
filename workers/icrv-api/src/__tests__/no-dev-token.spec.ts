// workers/icrv-api/src/__tests__/no-dev-token.spec.ts
//
// Regression: the temporary `/dev/gen-token` HS256-mint backdoor must stay
// deleted. It contradicted the Cloudflare Access cutover (PR 6) and was
// removed in Phase A of the cutover sprint. This test fails if anyone wires
// it back in.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('no /dev/gen-token backdoor', () => {
  const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

  it('source contains no /dev/ route registration', () => {
    expect(indexSrc).not.toMatch(/app\.(get|post|put|patch|delete|all)\([\s\S]*?['"]\/dev\//);
  });

  it('source contains no gen-token / X-Dev-Key strings', () => {
    expect(indexSrc).not.toMatch(/gen-token/i);
    expect(indexSrc).not.toMatch(/X-Dev-Key/i);
    expect(indexSrc).not.toMatch(/icrv_dev_bootstrap/);
  });
});
