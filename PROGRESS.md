# Progress

**The current state only.** The dated history, with what each test proved, is in [docs/progress-log.md](docs/progress-log.md). Update this file whenever the state changes, and before context runs out.

_Last verified against the code: 4 Nov 2026, commit `6e4edc9`._

## Handoff

- **Current stage:** Stage 4 (core application) plus the import work moved forward (AP-15). **Not finished:** see "Missing from Stage 4".
- **Current task:** none in progress. The context-preservation system was just set up.
- **Next action:** get the user's answers to "Pending decisions" 1 and 2, then build the top item of "Next steps".
- **Don't:** start Stage 5 before the user has seen the corrected Stage 4 status.

## Correction to an earlier report

On 4 Nov I told the user "Stage 4 is built" and described 2FA as optional for them to decide. Checking the code against the approved documents shows both were overstated: see "Missing from Stage 4" and decision AD-15. The user has been told.

## Stages

| Stage | Status |
|---|---|
| 1 Requirements, 2 Architecture | ✅ Approved 2 Nov 2026 |
| 3 Ledger core, login, isolation | ✅ Built, except staging (needs a Render account) |
| 4 Core application | 🟡 Most built; Must items missing |
| 7 Import (moved forward, AP-15) | 🟡 Built, except matching to planned bills (needs Stage 5) and real bank files |
| 5 Planning, full Safe to Spend | ⏳ Not started |
| 6 Reports | ⏳ Not started |
| 8 Hardening, 9 Launch | ⏳ Not started; each needs explicit approval |

## Built and tested

| Feature | Evidence | Code |
|---|---|---|
| Ledger: rules, builders, metrics; Safe to Spend **subset only** | Golden and property tests | `packages/domain/src` |
| Database guarantees: balancing, isolation, append-only history, locks | 26 attack tests | `packages/db/migrations`, `packages/db/test/integrity.test.ts` |
| Sign-up with consents, verification, sign-in, sign-out, sessions, login slowdown | API tests; browser journeys | `packages/api/src/auth.ts`, `login-throttle.ts` |
| Passkeys, with the user check enforced | Browser tests on a virtual device; mutation-tested | `auth.ts`, `e2e/passkeys.spec.ts` |
| Workspaces, accounts, transactions, transfers, summary | API tests | `packages/api/src/services.ts` |
| Edit, void, trash, restore, undo, version history, 30-day purge function | Golden, API and browser tests | `packages/db/src/lifecycle-store.ts` |
| Reconciliation, cash count, archive, merge | Golden, API and browser tests | `packages/api/src/reconciliation.ts`, `catalog.ts` |
| Export with AES-256 option | API tests; Windows `tar` | `packages/api/src/export.ts` |
| Activity log; account deletion with purge function | API and browser tests | `packages/api/src/deletion.ts`, `packages/db/src/deletion-store.ts` |
| CSV import: detect, map, classify, review, confirm, undo | Unit, API and browser tests | `packages/domain/src/csv-import.ts`, `packages/api/src/imports.ts`, `apps/web/src/app/import` |
| Screens | Browser tests with axe | `apps/web/src/app` |

## Test results (actual)

| Check | Result | When |
|---|---|---|
| `npm test` | 229 passed, 10 todo, 0 failed, 13 files | 4 Nov 2026, re-run for this document |
| `npm run typecheck` | Clean | 4 Nov 2026, re-run for this document |
| `npm run e2e` | 22 passed (11 journeys × desktop, phone) | 4 Nov 2026, at `cec68b2`; no code has changed since |
| `next build` | Succeeded | 4 Nov 2026, before the last test-only change |

**Golden tests, 71 in total.** With an automated test: GT-01 to 09, 11 to 15, 17 to 19, 21 to 27, 35, 36, 38 (ledger part), 39, 40 to 45, 59 (not search), 70, 71. **Not yet:** GT-10, 16, 20, 28 to 34, 37, 46 to 58, 60 to 69. Only some of these appear as "todo" in the test run, although `packages/golden/src/index.ts` says the list is complete.

**Never tested:** real bank files; real phones, Windows Hello or fingerprint readers; opening an encrypted export in 7-Zip, Windows Explorer or macOS; a manual screen-reader pass; the production email path; load at 50,000 transactions.

## Missing from Stage 4

Checked by searching the routes and screens on 4 Nov 2026. "API" means it exists without a screen.

| Must item | State |
|---|---|
| **Password reset** (FR-01, AC-01.3) | Library route only: no screen, no test |
| Change password; sign out everywhere (AC-01.4) | No screen, no test of the password-change case |
| **2FA, optional, at launch (AD-15)** | Plugin on: no screen, no test |
| Refund, debt payment and split entry; editing them (FR-04, FR-06) | API only for entry; no edit form |
| Search and filter with a server total (BR-04.5, AC-04.5); GT-59 search | Only a month picker; lists aren't paged |
| Edit an account; change an opening balance (E-03) | No route or screen |
| Add or rename a category | Add is API only; rename is missing |
| Workspace settings: protected reserve, time zone | No route or screen, so the reserve is always 0 |
| Profile and language; withdraw marketing consent (`/me`, Annex L) | No route or screen |
| Payees (FR-05) | Table only |
| Legal pages linked from sign-up; business details (Annex L) | Tick boxes name the documents, with nothing to open. Texts need a lawyer |
| Uncategorized total on screen (AC-05.3) | Not shown |
| Export round trip (the §12.2 exit criterion; AC-17.4 is a Should) | Not built. The two conflict: see decisions |

## Known issues and limits

- **Purges aren't scheduled.** Trash and deletion purges are tested functions with no worker to run them, so the on-screen promises wouldn't be kept in production (Stage 8 at the latest).
- **Drizzle isn't used**, though AD-09 approved it: see "Pending decisions".
- **Production can't send email** yet: it throws until Scaleway is configured (`apps/web/src/server/app.ts`).
- A user who never finished onboarding can't delete their account in the app.
- Audit log retention (24 months) isn't implemented.
- `'unsafe-inline'` in the browser security policy, to be replaced before launch (T-21).
- Stage 2's generated route-by-route isolation matrix doesn't exist; isolation tests are hand-written. Property tests cover P1, P2 and P4 of P1 to P8.
- The dashboard and API load all of a workspace's transactions per request; NFR-03 isn't measured (T-16).
- Windows dev only: a `.next` file-lock error once (clear `apps/web/.next`), and occasional leftover test processes (T-52).

## Pending decisions and dependencies

**From the user, needed now**
1. **Drizzle:** add it as AD-09 approved, or approve the raw parameterized SQL now in use? Recommendation: approve what exists (see DECISIONS.md).
2. **Order:** finish the Stage 4 list before Stage 5? Recommendation: yes for login, entry and settings items, because Stage 5 depends on them.

**From the user, before launch**
3. Render account (staging). Final name and domain (passkeys bind to the domain).
4. A few real bank CSVs with personal details removed. Review of the default categories (T-13).
5. A lawyer: LQ-01 to LQ-08, LQ-10, legal texts, and the retention questions in the progress log.
6. OK to record TR-01 to TR-20 (Annex L) in the Stage 1 spec.
7. Render's SOC 2 report (needs Pro and an NDA); DPAs for Scaleway, Sentry and Hetzner.

## Next steps, in priority order

1. Get decisions 1 and 2 above.
2. Password reset and change-password screens, with tests (AC-01.3, AC-01.4).
3. 2FA screens and journey (AD-15, Stage 2 §12.3).
4. Refund, debt payment and split entry and editing.
5. Search and filter with a server total; GT-59 search.
6. Account editing, opening balance edits, category add and rename, workspace settings (protected reserve), `/me` and marketing consent.
7. Payees, then the Uncategorized total.
8. Re-check Stage 4 against §12.2 and report.
9. Run the Safe to Spend user test plan with the user (Stage 2 §17.2), then Stage 5.
