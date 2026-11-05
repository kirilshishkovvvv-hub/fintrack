# Progress

**The current state only.** The dated history, with what each test proved, is in [docs/progress-log.md](docs/progress-log.md). Update this file whenever the state changes, and before context runs out.

_Last verified against the code: 4 Nov 2026, see "Test results". Documents updated 5 Nov 2026._

## Handoff

- **Current stage:** Stage 4 (core application) plus the import work moved forward (AP-15). **The buildable list is finished. Stage 4's exit needs only a staging deploy,** which needs a Render account: see "What still stands between Stage 4 and done".
- **Current task:** none in progress. The Stage 4 report went to the user.
- **Next action:** start Stage 5, ledger and API first. The Safe to Spend user test (Stage 2 §17.2) must run before the Stage 5 UI is finalized, not before Stage 5 starts.
- **Don't:** new queries stay plain SQL until decision D-1.

## Correction to an earlier report

On 4 Nov I told the user "Stage 4 is built" and described 2FA as optional for them to decide. Checking the code against the approved documents shows both were overstated: see "Missing from Stage 4" and decision AD-15. The user has been told.

## Stages

| Stage | Status |
|---|---|
| 1 Requirements, 2 Architecture | ✅ Approved 2 Nov 2026 |
| 3 Ledger core, login, isolation | ✅ Built, except staging (needs a Render account) |
| 4 Core application | 🟡 Built and tested; exit needs staging only; legal text needs a lawyer |
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
| `npm test` | 283 passed, 10 todo, 0 failed, 18 files | 4 Nov 2026 |
| `npm run typecheck` | Clean | 4 Nov 2026 |
| `npm run e2e` | 46 passed in the last full run; 2 added after it (the Uncategorized notice) passed on their own. **One failure seen once, not explained:** see "Known issues" | 4 Nov 2026 |
| `next build` | Succeeded, with dummy settings | 4 Nov 2026 |

**Golden tests, 71 in total.** With an automated test: GT-01 to 09, 11 to 15, 17 to 19, 21 to 27, 35, 36, 38 (ledger part), 39, 40 to 45, 59 (search included), 70, 71. **Not yet:** GT-10, 16, 20, 28 to 34, 37, 46 to 58, 60 to 69. Only some of these appear as "todo" in the test run, although `packages/golden/src/index.ts` says the list is complete.

**Never tested:** real bank files; real phones, Windows Hello or fingerprint readers; opening an encrypted export in 7-Zip, Windows Explorer or macOS; a manual screen-reader pass; the production email path; load at 50,000 transactions.

## What still stands between Stage 4 and done

Checked against Stage 1 §12.2 and §13, and Stage 2 §9.2, on 4 Nov 2026.

| Item | State | Needs |
|---|---|---|
| Export round trip (AC-17.4) | Not built. A Should, no longer an exit criterion (D-2, 5 Nov) | Later |
| Staging deploy (Stage 3 exit) | Not done | **Render account** |
| Legal texts, business details (Annex L) | Draft shells only | **Lawyer; the user's details** |
| "Schedule instead" offer on a future date (AC-04.4) | Date is refused, with a hint; nothing to schedule until Stage 5 | Stage 5 |
| Tag filter (BR-04.5) | Tags are a Should and aren't built | Later |
| Import rules for payees (BR-05.6); delete an unused category (BR-05.4); account type conflict | Not built, or built one way | **D-11, D-12, D-10** |
| `PATCH /me`, unsubscribe route, `email_preferences` | Not built: one language, no name, no marketing email yet (T-64) | When those arrive |

## Known issues and limits

- **One unexplained test failure.** The phone sign-up journey (`e2e/journeys.spec.ts:7`) failed once in a full run, with a list that should have been empty holding one item. That matches the accessibility check or the new missing-translation guard; the output didn't show which. It then passed 5 times alone and once in the next full run. Print the full failure if it returns.
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

1. Get the decisions above.
2. Stage 5: budgets, recurring rules, matching, goals, cards and debts, calendar, full Safe to Spend.
3. Before the Stage 5 UI is finalized: a clickable prototype with invented data, then the Safe to Spend user test with 5 people (Stage 2 §17.2). The user recruits them.
