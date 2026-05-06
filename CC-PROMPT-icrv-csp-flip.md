# Claude Code task — Autonomous CSP enforcing flip for ICRV

The hardening sprint and cutover are complete. One Critical-severity item is partially closed and needs the final move: flip CSP from `Content-Security-Policy-Report-Only:` to `Content-Security-Policy:` (enforcing) on `frontend/public/_headers`, but only after verifying no violations fire across every authenticated route.

Drive this autonomously using Playwright with a Cloudflare Access service token. Block only at one checkpoint (the upfront service-token ask) and at one decision point (if real violations surface). Otherwise: install, walk, flip, deploy, document.

## Read first

1. `HARDENING_REPORT.md` — current Backlog item #1 is this exact task; § "Final state pin" is the post-cutover baseline
2. `frontend/public/_headers` — the current CSP is `Content-Security-Policy-Report-Only`; `connect-src` includes `https://icrv-api.americanironus.com`, `https://icrv-api.americanironadmin.workers.dev` (transitional), `https://*.ingest.sentry.io`
3. `workers/icrv-api/src/index.ts` — `/csp-report` POST handler that logs violations
4. `frontend/src/App.tsx` and `frontend/src/components/Sidebar.tsx` — the route map (7 sidebar routes + their modals)

## Decisions already made — do not ask, just do

- **Walk method:** Playwright Chromium (headless), authenticated via Cloudflare Access service token using `CF-Access-Client-Id` and `CF-Access-Client-Secret` request headers. This bypasses the Access login page so the service token doesn't need to map to a D1 user. The SPA shell will render and execute; API calls behind `/v1/*` will return 401/403 (because the service token's JWT doesn't carry an email that matches a D1 user) — that's fine. CSP violations fire on resource loads, not API responses, so the walk's signal is intact.
- **Walk scope:** all 7 routes (`/`, `/contacts`, `/campaigns`, `/ai`, `/logs`, `/calls`, `/settings`) plus every modal Playwright can trigger via clicking `+ New Contact`, the row's edit pencil if a contact row exists, `Bulk Upload`, the kill-switch button, and the run-reject button. If a modal can't open because data isn't present (e.g. no contacts to edit), skip it and note in the report.
- **Violation collection:** two channels in parallel.
  - Browser side: Playwright's `page.on('console')` for `Refused to load...` messages AND `page.on('response')` to capture POSTs to `/csp-report`.
  - Worker side: a `wrangler tail --name icrv-api --format json` subprocess running for the duration of the walk, grepping for `csp-report` log lines.
- **Flip threshold:** zero violations across both channels → flip enforcing and deploy. Any violation → stop, dump the violation list to a `csp-violations.txt` file at repo root, do NOT flip, and report the violations with proposed fixes (either widen the policy with one additional `connect-src` / `img-src` / etc. entry, or fix the offending source). Wait for the human to choose.
- **Service token credentials:** ask the human ONCE upfront. Store in a local `.csp-walk.env` (gitignored) for the run, delete after.
- **Cleanup:** `playwright` is installed as a dev dependency in `frontend/`. `csp-walk.spec.ts` lives at `frontend/scripts/csp-walk.spec.ts`. Both stay committed for repeatability — future audits can re-run the same walk.

## Operating rules

1. One topic branch: `polish/csp-enforce-flip`. Single PR. Reference Backlog #1 from `HARDENING_REPORT.md`.
2. No production deploy until the walk reports zero violations.
3. If violations surface, do NOT auto-widen the policy. Surface them to the human with the exact `_headers` line you'd propose adding, and wait.
4. After deploy, re-run `bash scripts/audit-check.sh https://icrv.americanironus.com https://icrv-api.americanironus.com` and update `HARDENING_REPORT.md` § Status table — the C3 row moves from "✓ partial" to "✓ closed" and Backlog item #1 gets struck through.
5. Conventional commits. Reference C3 closure in the deploy commit message.

## Phase A — Single batched ask for the service token

Ask the human once, in one message:

```
Need a Cloudflare Access service token for the headless route walk
(autonomous Phase D verification before flipping CSP enforcing).

Create one at:
  Cloudflare → Zero Trust → Access → Service Auth → Service Tokens
  → Create Service Token
  Name:     icrv-csp-walk
  Duration: 1 year (or shortest you're comfortable with)

Then attach the token to the ICRV Application:
  Zero Trust → Access → Applications → ICRV → Edit → Policies
  → Add a policy
  Name:     CSP walker (service token)
  Action:   Service Auth
  Selector: Service Token
  Value:    icrv-csp-walk
  Apply this policy to the icrv-api.americanironus.com /v1/* destination
  AND to icrv.americanironus.com (no path).

After creation, paste:
  CLIENT_ID=     <Client ID>
  CLIENT_SECRET= <Client Secret>

If you don't want to create one, type "skip" and I'll fall back to a
manual-walk recipe printed for you to run yourself.
```

If the human types `skip`, abort autonomously and print the manual recipe (the same one I gave them in chat). Do not attempt a partial walk without the token.

## Phase B — Install + walk (autonomous)

Once you have the token:

1. Persist credentials to `.csp-walk.env` (mode 600, gitignored):
```bash
cd ~/Documents/icrv
echo ".csp-walk.env" >> .gitignore
echo "CF_ACCESS_CLIENT_ID=$CLIENT_ID" > .csp-walk.env
echo "CF_ACCESS_CLIENT_SECRET=$CLIENT_SECRET" >> .csp-walk.env
chmod 600 .csp-walk.env
```

2. Branch:
```bash
git switch main && git pull && git switch -c polish/csp-enforce-flip
```

3. Install Playwright in `frontend/`:
```bash
cd frontend
npm install --save-dev @playwright/test
npx playwright install chromium
```

4. Write the walk spec at `frontend/scripts/csp-walk.spec.ts`. The spec should:
   - Load `.csp-walk.env` via dotenv
   - Set `extraHTTPHeaders: { 'CF-Access-Client-Id': ..., 'CF-Access-Client-Secret': ... }` on the browser context
   - Subscribe to `page.on('console')` and filter for messages whose text matches `/refused to|content security policy/i` — push each into a `violations` array with `{ source: 'console', route, message }`
   - Subscribe to `page.on('request')` and capture any POST to `/csp-report`, log the body — push to violations with `{ source: 'csp-report', route, body }`
   - For each route in `['/', '/contacts', '/campaigns', '/ai', '/logs', '/calls', '/settings']`:
     - `page.goto('https://icrv.americanironus.com' + route, { waitUntil: 'networkidle', timeout: 20_000 })`
     - Wait an extra 2 seconds for any deferred resource loads
     - For routes with known modals, attempt to click each modal trigger (`text=/new contact/i`, `text=/bulk upload/i`, `text=/kill[- ]switch/i`, `text=/reject/i`) inside a try/catch — if a button doesn't exist, log and continue
     - Wait 1s after each modal opens for resource loads
     - Close the modal (`page.keyboard.press('Escape')`) and continue
   - At the end, write the `violations` array to `frontend/scripts/csp-walk-results.json` and to a human-readable `csp-violations.txt` at repo root if non-empty

5. In parallel with the walk, run `wrangler tail --name icrv-api --format json` as a background subprocess piped to a temp file. Spawn it before `npx playwright test` and kill it after. Grep the temp file for any line containing `csp-report` and merge those into the violations list.

6. Run:
```bash
cd ~/Documents/icrv/frontend
PLAYWRIGHT_TEST_BASE_URL=https://icrv.americanironus.com \
  npx playwright test scripts/csp-walk.spec.ts --reporter=list
```

7. Read `csp-walk-results.json`. Branch:
   - **If empty (zero violations):** proceed to Phase C
   - **If non-empty:** stop. Print a structured summary to the human, including for each violation: source (console/csp-report), route, blocked-uri (if available), violated-directive, and your proposed fix (e.g. "add `https://example.com` to `connect-src`" or "remove the inline `<script>` at `frontend/index.html:42`"). Wait for human direction.

## Phase C — Flip + deploy (autonomous, only on zero violations)

1. Flip the policy in `frontend/public/_headers`:
```bash
cd ~/Documents/icrv
sed -i '' 's/Content-Security-Policy-Report-Only:/Content-Security-Policy:/' frontend/public/_headers
```

2. Verify the substitution worked (exactly one match changed; no `Report-Only` left):
```bash
grep -c "Content-Security-Policy-Report-Only" frontend/public/_headers   # expect 0
grep -c "^  Content-Security-Policy:"          frontend/public/_headers   # expect 1
```

3. Commit:
```bash
git add frontend/public/_headers frontend/package.json frontend/package-lock.json \
        frontend/scripts/csp-walk.spec.ts frontend/scripts/csp-walk-results.json \
        .gitignore
git commit -m "feat(security): flip CSP from Report-Only to enforcing (closes C3 fully)

Autonomous Phase D walk via Playwright + CF Access service token across
every sidebar route and reachable modal returned zero violations on both
the browser console channel and the /csp-report worker channel. Walk
script committed at frontend/scripts/csp-walk.spec.ts for future audits.

Closes Backlog #1 in HARDENING_REPORT.md."
```

4. Build + deploy frontend production:
```bash
cd frontend && npm run build && \
  wrangler pages deploy dist --project-name icrv-dashboard --branch main
```

5. Verify the deployed header:
```bash
curl -sI https://icrv.americanironus.com/ | grep -i content-security-policy
# Expect: a single line starting with `content-security-policy:` (NOT report-only)
```

If the curl shows `Content-Security-Policy-Report-Only` still, the Pages deployment hasn't propagated yet — wait 60s and retry. If after 3 retries it's still wrong, stop and report.

6. Re-run the audit-check:
```bash
cd ~/Documents/icrv && bash scripts/audit-check.sh \
  https://icrv.americanironus.com https://icrv-api.americanironus.com \
  | tee /tmp/audit-csp-enforce.txt
```

7. Update `HARDENING_REPORT.md`:
   - In the Status table, change the C3 row from "✓ partial" (or whatever it currently reads) to "✓ closed (PR polish/csp-enforce-flip)"
   - In the Cutover log, append a dated entry: `2026-MM-DD: CSP flipped to enforcing after zero-violation autonomous Playwright walk; deploy verified by curl + audit-check.sh`
   - In the Backlog, strike through item #1 with a `~~...~~` markdown formatting and add `(closed YYYY-MM-DD)` after it

8. Push and merge:
```bash
git add HARDENING_REPORT.md
git commit -m "docs(report): mark C3 fully closed after CSP enforcing flip"
git push origin polish/csp-enforce-flip
git switch main
git merge --no-ff polish/csp-enforce-flip -m "merge: CSP enforcing flip (closes C3, Backlog #1)"
git push origin main
```

9. Cleanup the credentials file:
```bash
rm -f .csp-walk.env
```

10. Print the final summary to the human:
```
✅ CSP enforcing — flipped + deployed + verified.

Walk results:        zero violations across 7 routes + N modals
Deploy:              <pages-deployment-id> at https://icrv.americanironus.com
Header verified:     content-security-policy: default-src 'self'; ...
Audit-check.sh:      all green (output at /tmp/audit-csp-enforce.txt)
HARDENING_REPORT:    C3 row updated to "✓ closed", Backlog #1 struck through
Branch:              polish/csp-enforce-flip merged into main, pushed
Walk artifact:       frontend/scripts/csp-walk.spec.ts (re-runnable for future audits)

C3 is now the second-to-last Critical fully closed (only C7's transitional
pages.dev allowlist entry remains, Backlog #9). The hardening sprint's
critical work is effectively complete.
```

## When to ask vs. decide

You ask the human exactly twice:
1. **Phase A start** — for the CF Access service token credentials (or `skip`).
2. **Phase B end, only if violations found** — surface them with proposed fixes and wait.

Everything else: decide, document in the commit message, ship.

## Reminder

You're closing the last Critical-severity loose end. The walk is the safety net; the flip is the win. Don't skip the walk to save time — its whole purpose is to make the flip safe. But don't stall on the walk either — Playwright reports clean → flip immediately.
