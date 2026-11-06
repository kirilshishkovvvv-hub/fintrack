# Progress

**The current state only.** The dated history, with what each test proved, is in [docs/progress-log.md](docs/progress-log.md). Update this file whenever the state changes, and before context runs out.

_Last verified against the code: 6 Nov 2026, see "Test results"._

## Handoff

- **Current stage:** Stage 6 built and tested. **All the buildable work of Stages 3 to 7 is done.** What's left before Stage 8 needs the user: see "What stands between here and Stage 8".
- **Current task:** none in progress. The Stage 6 report went to the user.
- **Next action:** wait for the user. **Stage 8 needs their explicit approval** and an outside security firm. The user test can run at any time: the prototype is at https://claude.ai/artifact/81oWGRLbGpwyh1GBRSATPJ, and the guide is [docs/sts-user-test.md](docs/sts-user-test.md).
- **Don't:** start Stage 8 or 9 without approval. New queries stay plain SQL until decision D-1.

## Correction to an earlier report

On 4 Nov I told the user "Stage 4 is built" and described 2FA as optional for them to decide. Checking the code against the approved documents shows both were overstated: see "Missing from Stage 4" and decision AD-15. The user has been told.

## Stages

| Stage | Status |
|---|---|
| 1 Requirements, 2 Architecture | ✅ Approved 2 Nov 2026 |
| 3 Ledger core, login, isolation | ✅ Built, except staging (needs a Render account) |
| 4 Core application | 🟡 Built and tested; exit needs staging only; legal text needs a lawyer |
| 7 Import (moved forward, AP-15) | 🟡 Built, including matching to planned bills; real bank files untested |
| 5 Planning, full Safe to Spend | 🟡 Built and tested; user test not run, so the screens aren't final |
| 6 Reports | ✅ Built and tested, including the speed targets on this machine |
| 8 Hardening, 9 Launch | ⏳ Not started; each needs explicit approval |

## Built and tested

| Feature | Evidence | Code |
|---|---|---|
| Ledger: rules, builders, metrics | Golden and property tests | `packages/domain/src` |
| Full Safe to Spend (§7): payday window, option (c), card reserve, AM-1, R5, every item traceable (P8) | Golden tests with the spec's numbers | `packages/domain/src/sts.ts`, `SafeToSpendCard.tsx` |
| Recurring rules, planned items, confirm, match, skip, regenerate, matching rules M-1 to M-7 | Unit, golden, API and browser tests | `packages/domain/src/planning.ts`, `packages/api/src/planning.ts`, `apps/web/src/app/plan` |
| Budgets: limits, carrying forward, thresholds fired once, overall limit, instalment note | Golden, API and browser tests | `packages/api/src/budgets.ts`, `apps/web/src/app/budgets` |
| Goals: virtual and dedicated, shortfalls, backed amounts, use goal money, conversions, Save for a bill | Golden, API and browser tests | `packages/domain/src/goals.ts`, `packages/api/src/goals.ts`, `apps/web/src/app/goals` |
| Debt overview; loan details | API and browser tests | `getDebts` in `budgets.ts`, `apps/web/src/app/debts` |
| Import rows matched to planned items (GT-37, GT-38) | API and browser tests | `packages/api/src/imports.ts` |
| Projection (a Should) | Unit, API and browser tests | `packages/domain/src/projection.ts`, `apps/web/src/app/reports` |
| Dashboard: period, every FR-14 widget, each figure opening its lines | API and browser tests (AC-14.1, AC-14.2) | `packages/api/src/reports.ts`, `apps/web/src/app/dashboard` |
| Reports: by month, by category, comparison, budget against actual, net worth; CSV | Golden (GT-60), property, API and browser tests | `packages/domain/src/reports.ts`, `apps/web/src/app/reports` |
| Speed at 50,000 and 100,000 transactions (NFR-03, AC-14.3) | `npm run perf`: see below | `packages/api/perf/load.perf.ts` |
| Database guarantees: balancing, isolation, append-only history, locks | 26 attack tests | `packages/db/migrations`, `packages/db/test/integrity.test.ts` |
| Sign-up with consents, verification, sign-in, sign-out, sessions, login slowdown | API tests; browser journeys | `packages/api/src/auth.ts`, `login-throttle.ts` |
| Passkeys, with the user check enforced | Browser tests on a virtual device; mutation-tested | `auth.ts`, `e2e/passkeys.spec.ts` |
| Workspaces, accounts, transactions, transfers, summary | API tests | `packages/api/src/services.ts` |
| Edit, void, trash, restore, undo, version history, 30-day purge function | Golden, API and browser tests | `packages/db/src/lifecycle-store.ts` |
| Reconciliation, cash count, archive, merge | Golden, API and browser tests | `packages/api/src/reconciliation.ts`, `catalog.ts` |
| Export with AES-256 option | API tests; Windows `tar` | `packages/api/src/export.ts` |
| Activity log; account deletion with purge function | API and browser tests | `packages/api/src/deletion.ts`, `packages/db/src/deletion-store.ts` |
| CSV import: detect, map, classify, review, confirm, undo | Unit, API and browser tests | `packages/domain/src/csv-import.ts`, `packages/api/src/imports.ts`, `apps/web/src/app/import` |
| Full transaction form: refund, debt payment, split, percent split, line notes, duplicate | API and browser tests | `apps/web/src/components/TransactionForm.tsx` |
| Password reset and change, email change, sign out everywhere, 2FA, new-device notice | API and browser tests | `auth.ts`, `apps/web/src/app/settings/security` |
| Search and filter with a server total; accent-insensitive; paged | API and browser tests, including isolation (GT-59) | `listTransactions` in `services.ts`, `apps/web/src/app/transactions/page.tsx` |
| Payees: from entry and import, default category, merge | API and browser tests | `packages/db/src/payee-store.ts`, `catalog.ts` |
| Uncategorized total on the dashboard (current month, T-69) | API and browser tests | `summary` in `services.ts` |
| Account editing, opening balance (E-03), display order | API and browser tests | `packages/api/src/settings.ts` |
| Category add, rename, move, reorder | API and browser tests | `settings.ts`, `apps/web/src/app/categories` |
| Protected reserve, time zone, currency lock; marketing consent | API and browser tests | `settings.ts`, `apps/web/src/app/settings` |
| Legal page shells, marked as drafts, linked from sign-up and the footer | Browser tests | `apps/web/src/app/legal` |
| No missing translations (AC-22.1) | Source check and browser guard | `apps/web/test/messages.test.ts` |
| Screens | Browser tests with axe, at 1280 and 360 px | `apps/web/src/app` |

## Test results (actual)

| Check | Result | When |
|---|---|---|
| `npm test` | 468 passed, 7 todo, 0 failed, 23 files | 6 Nov 2026 |
| `npm run typecheck` | Clean | 6 Nov 2026 |
| `npm run e2e` | 80 tests. Last full run: 78 passed; 2 failed (one test at both widths) on an accessibility finding on the cookies page. After the fix: the settings and reports specs passed, 18 of 18. Only that page changed after the full run | 6 Nov 2026 |
| `next build` | Compiled, with dummy settings | 6 Nov 2026 |
| `npm run perf` | Every target met at both sizes | 6 Nov 2026 |

**Speed, p95, on this machine with the embedded database and one user at a time.** The load test on real infrastructure, with many users, belongs to Stage 8.

| | Target | 50,000 | 100,000 |
|---|---|---|---|
| Dashboard | 1.5 s | 0.40 s | 0.94 s |
| Slowest report | 3 s | 0.33 s | 0.71 s |
| All-time text search | 3 s | 0.94 s | 1.90 s |
| Saving an expense | 0.5 s | 0.03 s | 0.03 s |
| Importing 2,000 rows (one run) | 10 s | 4.7 s | **9.8 s, close to the limit** |

**Golden tests, 71 in total.** Everything Stages 3 to 6 need has an automated test, in the golden runners, the API tests or the domain tests. **Not yet, and listed as "todo":** GT-10 (Should), GT-46 and 47 (investments, Should). GT-58's last point, a CSV with both a transaction and a booking date, relies on the import mapping tests.

**Never tested:** real bank files; real phones, Windows Hello or fingerprint readers; opening an encrypted export in 7-Zip, Windows Explorer or macOS; a manual screen-reader pass; the production email path; speed on real infrastructure or with many users.

## What still stands between Stage 4 and done

Checked against Stage 1 §12.2 and §13, and Stage 2 §9.2, on 4 Nov 2026.

| Item | State | Needs |
|---|---|---|
| Export round trip (AC-17.4) | Not built. A Should, no longer an exit criterion (D-2, 5 Nov) | Later |
| Staging deploy (Stage 3 exit) | Not done | **Render account** |
| Legal texts, business details (Annex L) | Draft shells only | **Lawyer; the user's details** |
| Tag filter (BR-04.5) | Tags are a Should and aren't built | Later |
| Import rules for payees (BR-05.6); delete an unused category (BR-05.4); account type conflict | Not built, or built one way | **D-11, D-12, D-10** |
| `PATCH /me`, unsubscribe route, `email_preferences` | Not built: one language, no name, no marketing email yet (T-64) | When those arrive |

## What still stands between Stage 5 and done

Checked against Stage 1 §12.2, §13 and Stage 2 §9.2, §17 on 5 Nov 2026.

| Item | State | Needs |
|---|---|---|
| Safe to Spend user test (Stage 2 §17.2) | Prototype and guide ready; not run | **The user: 5 people** |
| Reminders and in-app notifications (FR-20, a Should) | Thresholds are recorded and shown on the budget; nothing notifies, so reminder days have no screen | Later |
| Calendar grid, monthly plan, suggesting a payday, auto-link (Shoulds) | Not built | Later |
| "Track as an asset" (BR-10.10) | The option appears, and points to adding an asset account. The purchase isn't converted for the user | Fine unless the user test says otherwise |

## Known issues and limits

- **Occurrences are generated on read** (T-72), and the worker doesn't exist. Harmless, but a user who never opens the app has no new occurrences until they do.
- **Import reads every transaction** when it classifies a file, which is why it comes closest to its limit at 100,000. Reconciliation does too. Both are fine at the 50,000 target (T-85).
- **AC-14.1 for balances in a past period:** income, spending and each category open lines that sum to the figure. Net worth for a past date opens the net worth report, which breaks it into assets and liabilities, not a list of lines by account (T-86).
- **Purges aren't scheduled.** Trash and deletion purges are tested functions with no worker to run them, so the on-screen promises wouldn't be kept in production (Stage 8 at the latest).
- **Drizzle isn't used**, though AD-09 approved it: see "Pending decisions".
- **Production can't send email** yet: it throws until Scaleway is configured (`apps/web/src/server/app.ts`).
- A user who never finished onboarding can't delete their account in the app.
- Audit log retention (24 months) isn't implemented.
- `'unsafe-inline'` in the browser security policy, to be replaced before launch (T-21).
- Stage 2's generated route-by-route isolation matrix doesn't exist; isolation tests are hand-written. Property tests cover P1, P2 and P4 of P1 to P8.
- Windows dev only: a `.next` file-lock error once (clear `apps/web/.next`), and occasional leftover test processes (T-52).

## Pending decisions and dependencies

**From the user, needed now**
1. **D-1, Drizzle:** approve the raw parameterized SQL in use (recommended), or add Drizzle as AD-09 approved?
2. **D-10, D-11, D-12:** three small conflicts or gaps in the approved documents. See DECISIONS.md.

**From the user, before launch**
3. Render account (staging). Final name and domain (passkeys bind to the domain).
4. A few real bank CSVs with personal details removed. Review of the default categories (T-13).
5. A lawyer: LQ-01 to LQ-08, LQ-10, legal texts, and the retention questions in the progress log.
6. OK to record TR-01 to TR-20 (Annex L) in the Stage 1 spec.
7. Render's SOC 2 report (needs Pro and an NDA); DPAs for Scaleway, Sentry and Hetzner.

## What stands between here and Stage 8

| Item | Needs |
|---|---|
| Staging deploy (Stage 3 exit) | **Render account** |
| Safe to Spend user test (Stage 5) | **5 people** |
| Decisions D-1, D-10, D-11, D-12 | **The user** |
| Stage 8 itself | **The user's approval**, and an outside firm for the penetration test |

**Reports that are Shoulds and aren't built:** largest transactions, Cash Change by account, interest by debt.

## Next steps, in priority order

1. The user: the items above, in any order.
2. Stage 8 once approved: penetration test, ASVS L2 review, load test, restore drill, accessibility audit, the background worker (purges, occurrences), audit retention, removing `'unsafe-inline'`.
3. Stage 9 once approved: production, monitoring, legal documents, closed beta, launch.
