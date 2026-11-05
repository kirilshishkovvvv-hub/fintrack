# Progress

**The current state only.** The dated history, with what each test proved, is in [docs/progress-log.md](docs/progress-log.md). Update this file whenever the state changes, and before context runs out.

_Last verified against the code: 5 Nov 2026, see "Test results"._

## Handoff

- **Current stage:** Stage 5 built and tested. **It can't be called final:** the Safe to Spend user test hasn't run, and it may change wording and layout. Stage 4's exit still needs a staging deploy.
- **Current task:** none in progress. The Stage 5 report went to the user.
- **Next action:** Stage 6 (dashboard, core reports, projection screen), unless the user says otherwise. The user test can run alongside it: the prototype is at https://claude.ai/artifact/81oWGRLbGpwyh1GBRSATPJ, and the guide is [docs/sts-user-test.md](docs/sts-user-test.md). The prototype's source is `docs/sts-prototype.html`, and its figures are checked by the golden tests named "§7.8 Example 1".
- **Don't:** new queries stay plain SQL until decision D-1.

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
| 6 Reports | ⏳ Not started |
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
| Projection (a Should) | Unit and API tests; **no screen yet** (Stage 6) | `packages/domain/src/projection.ts` |
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
| `npm test` | 446 passed, 8 todo, 0 failed, 21 files | 5 Nov 2026 |
| `npm run typecheck` | Clean | 5 Nov 2026 |
| `npm run e2e` | 72 tests. Last full run: 70 passed; 2 failed (one new test at both widths) because its expectation was wrong. After correcting that test, `e2e/planning.spec.ts` passed 24 of 24. Only that test file changed after the full run | 5 Nov 2026 |
| `next build` | Compiled, with dummy settings | 5 Nov 2026 |

**Golden tests, 71 in total.** Everything Stage 5 needs has an automated test, in the golden runners, the API tests or the domain tests. **Not yet, and listed as "todo":** GT-10 (Should), GT-46 and 47 (investments, Should), GT-60 (Stage 6). GT-58's last point, a CSV with both a transaction and a booking date, relies on the import mapping tests.

**Never tested:** real bank files; real phones, Windows Hello or fingerprint readers; opening an encrypted export in 7-Zip, Windows Explorer or macOS; a manual screen-reader pass; the production email path; load at 50,000 transactions.

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
| Onboarding prompts for rent and bills (§7.11) | Only the payday prompt exists, on the dashboard (T-76) | Stage 6 with the dashboard |

## Known issues and limits

- **Occurrences are generated on read** (T-72), and the worker doesn't exist. Harmless, but a user who never opens the app has no new occurrences until they do.
- **Reads got heavier.** Budgets, goals and Safe to Spend load every transaction per request, like everything else, and NFR-03 still isn't measured (T-16).
- **Purges aren't scheduled.** Trash and deletion purges are tested functions with no worker to run them, so the on-screen promises wouldn't be kept in production (Stage 8 at the latest).
- **Drizzle isn't used**, though AD-09 approved it: see "Pending decisions".
- **Production can't send email** yet: it throws until Scaleway is configured (`apps/web/src/server/app.ts`).
- A user who never finished onboarding can't delete their account in the app.
- Audit log retention (24 months) isn't implemented.
- `'unsafe-inline'` in the browser security policy, to be replaced before launch (T-21).
- Stage 2's generated route-by-route isolation matrix doesn't exist; isolation tests are hand-written. Property tests cover P1, P2 and P4 of P1 to P8.
- The dashboard, API and search load all of a workspace's transactions per request; NFR-03 isn't measured (T-16, T-56).
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

## Next steps, in priority order

1. Stage 6: dashboard widgets and period selector, core reports, projection screen, GT-60, the performance target.
2. The Safe to Spend user test, whenever the user has the people.
3. Get the decisions above.
