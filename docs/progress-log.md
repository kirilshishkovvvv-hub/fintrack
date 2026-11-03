# Progress log

The running record of implementation work: what was built, what was verified, and every technical choice made inside the approved design (Stage 1 spec and Stage 2 architecture). Anything that would change an approved rule or decision is **not** made here. It goes to you for approval first.

---

## Stage 4 · Core application (started 3 Nov 2026)

### Summary

| Piece | Status |
|---|---|
| Next.js web app with the API mounted at `/api/*`, security headers, no telemetry | ✅ Done |
| Translations through next-intl; English switched on (MKT-2); every visible text in `apps/web/messages/en.json` | ✅ Done |
| Consent records at sign-up: terms, privacy notice, 18+ (never pre-ticked), optional marketing (Annex L items 6 and 17) | ✅ Done, tested |
| Screens: sign-up, email verification, sign-in, onboarding (EUR or USD), dashboard, add account, add transaction, activity list | ✅ Done, checked in the browser |
| Local development: `npm run dev:all` starts a local database and the web app; security emails print to the server log | ✅ Done |
| Edit, void, delete to trash, restore and undo, with a version history per transaction; 30-day trash purge | ✅ Done, tested, checked in the browser |
| Reconciliation with adjustments and locks, quick balance update, archive and merge (GT-40 to GT-42, GT-45) | ✅ Done and tested (177 tests); screens built; **browser check still to do** |
| Export; audit view | ⏳ Next |
| "Keep me signed in", per-account login slowdown, account deletion | ⏳ Next |
| CSV import (moved here from Stage 7, AP-15) | ⏳ After the above |
| End-to-end browser tests (Playwright) | ⏳ Next |

**Test run (3 Nov 2026, evening):** 148 passed, 11 todo, 0 failed. Both type checks clean.

### Added on 3 Nov 2026: edit, void, trash, restore and undo

- **What the user can do:** open any transaction from the activity list, then:
  - **edit** it (amount, account, category, date, description);
  - **void** it (it stays visible, struck through, and counts nowhere);
  - **delete** it (to "Recently deleted" for 30 days);
  - **restore** it.

  Each action shows an **Undo** button for 10 seconds (GAP-4). Every transaction has a history listing who changed what and when; for edits it shows old → new amount and date.
- **Golden scenarios, in memory and through PostgreSQL** (29 in all, 7 of them new):
  - GT-43: the date moves to 1 Apr, so March has 0 and April has 50 (Food 20.0 %);
  - E-38: an amount edit changes only the difference, and a change of account moves the expense from assets to liabilities;
  - GT-44: voiding, then restoring, gives back exactly the same figures;
  - AC-19.1: delete then restore gives identical balances;
  - E-39: a deleted transaction counts nowhere.

  The database run now replays each scenario's history through the same edit and status functions the app uses.
- **API tests (15 new):**
  - an edit records the old and new values (AC-19.2), and can even change an expense into a transfer;
  - a missing version answers 428 and a stale one 409, and nothing changes;
  - an edit that breaks a rule (future date, before the opening date) leaves the transaction untouched;
  - opening balances can't be edited here, and a voided transaction can't be edited until it's restored;
  - a repeated void with the same key is answered once;
  - undo:
    - undoing a create moves it to the trash;
    - undoing an edit restores the previous version;
    - undoing a delete restores it;
    - only the latest change can be undone, only once, and only within the window;
  - purging after 30 days removes the transaction and its history, but keeps audit events with IDs only. A refund of a purged purchase keeps its amount and loses only the link (GAP-2);
  - another user gets 404 on every action, and can't use someone else's undo token.
- **Database tests (2 new):**
  - the maintenance role can delete only trashed transactions and can read nothing else;
  - a web-server login that belongs only to `fin_app` can't switch to the maintenance role.
- **A bug found in the browser and fixed:** the 30-minute idle session behaved as a 30-minute absolute one, because the refreshed session cookie never reached the browser. It now does. A test covers it, and it fails without the fix.
- **Waiting for Stage 5:** a voided or deleted transaction that completed a planned bill sends the bill back to Planned (GT-44 occurrence part, GAP-1), because planned items don't exist yet. These are listed as "todo" in the test run.

### Checked in the browser (3 Nov 2026, evening)

1. Edit "45,60" → "54,60" → the detail shows −€54.60, the history says "Edited · −€45.60 → −€54.60", and an Undo button appears.
2. Delete → it leaves the activity list → Undo → it's back, without reloading the page.
3. Void → balance back to €1,000.00; the row stays, struck through and labelled "Voided" → Restore.
4. Delete → "Recently deleted" shows it with its removal date (30 days later) → Restore → Safe to Spend €954.40 again.
5. At 360 px wide, no horizontal scrolling on the detail and edit screens, and every control has a label.

### Checked in the browser (3 Nov 2026)

Full flow with a local test account:
1. Sign up (with the consent boxes) → "check your inbox".
2. Follow the verification link from the server log → "your email is verified".
3. Sign in → sent to onboarding, because there's no workspace yet.
4. Choose EUR → empty dashboard.
5. Add a Current account with "1,000.00" → Safe to Spend and net worth show €1,000.00.
6. Add an expense of "45,60" in Food › Groceries → €954.40, and the expense appears in recent activity as "−€45.60".

At 360 px wide there's no horizontal scrolling on the dashboard or the add-transaction screen, and every input, select and button has a label.

### Technical choices made inside the approved design

| # | Choice | Why | Reversible? |
|---|---|---|---|
| T-19 | **Next.js 16.4.2, React 19.1.10, next-intl 4.14.9**, pinned versions at least two weeks old | Approved stack (AD-01, AD-22). | Easy |
| T-20 | The migration runner isn't exported from `@fintrack/db` | The web bundler tried to package the migrations folder; only scripts and tests run migrations. | — |
| T-21 | **CSP:** no third-party origins at all, but `'unsafe-inline'` for scripts for now | Next.js needs inline scripts for hydration. A nonce-based policy replaces this **before launch** (Stage 8). | Easy |
| T-22 | **Next.js telemetry switched off** in development | Nothing leaves the machine (AD-21). | — |
| T-23 | **Sign-up consents** are checked before Better Auth does anything, and stored after the user is created; document versions are `draft-2026-11` until the lawyer-reviewed texts exist | So a refusal reveals nothing about existing emails (AC-01.2), and every consent records which text was accepted. | Easy |
| T-24 | **Amount entry** accepts "12.50", "12,50", "1,234.56", "1.234,56" and "1 234,56"; when both separators appear, the last one is the decimal | People type both styles; anything ambiguous is rejected, never guessed. | Easy |
| T-25 | **Resolved:** embedded PostgreSQL 18 on Windows left orphaned I/O worker processes after a test or dev run, which blocked the next dev start | Local clusters now use synchronous I/O (`io_method=sync`), so those processes never start. Development and tests only; production is Render's managed PostgreSQL. | — |
| T-26 | **Edits remove the old postings and write new ones** in the same database transaction, under the workspace lock, with the version checked. Version entries store the full before and after transaction for edits, and only the status for void, delete and restore | LR-10 and AC-19.2, with the history readable on its own. | — |
| T-27 | **Undo token = the ID of the version entry** the action wrote. It works only for the same user, only while that change is still the latest, and for 10 seconds plus 5 seconds' allowance for the network. Undoing a create moves the transaction to the trash instead of erasing it | GAP-4. Nothing is ever erased by an undo, and the undo itself appears in the history. | Easy |
| T-28 | **Not editable through the edit form or `PATCH`:** opening balances, adjustments and valuations. They change through the account and reconciliation flows. The edit screen handles one-category expenses and income and plain transfers; other shapes (splits, fees) can be voided or deleted and re-entered for now | Keeps those system postings tied to their own rules (LR-05). Editing splits in the UI comes later. | Easy |
| T-29 | **Purging uses a separate role, `fin_maintenance`** (migration 0004). Row-level security limits it to trashed transactions, the refunds that point at them, expired idempotency records and new audit events. The purge function exists and is tested; its schedule comes with the background worker (Stage 8). **Production login roles:** the web server's login belongs only to `fin_app`, the worker's only to `fin_maintenance`, and migrations run as the owner | The application role still can't delete anything (Stage 2 §6.3). A test proves the web login can't switch roles. | Moderate |
| T-30 | **Session refresh cookies are passed on in every API response** | Fixes T-10: without it, the 30-minute idle limit acted as an absolute limit (found in the browser). | — |
| T-32 | **Reconciliation items are stored per transaction** (`fin.reconciliation_items`, migration 0005) instead of the planned `postings.reconciliation_id`, which is dropped | An edit replaces postings, and a broken reconciliation must still know what it covered (GT-42). A database trigger enforces the lock (SQLSTATE FTL01 → `LOCKED_RECONCILED`); only a category merge may move a locked category line. | Moderate |
| T-33 | **Preview and finish instead of a server-side draft:** `POST /reconciliations/preview` returns the figures for the ticks so far; `POST /reconciliations` finishes it. Unlocking also unlocks later reconciliations of the same account; a new reconciliation supersedes broken ones | Simpler than storing drafts, with the same rules. | Easy |
| T-34 | **Default category "Untracked spending"** added to the seed | Named by E-37 and GT-41. | Easy |
| T-35 | **Local PostgreSQL clusters are UTF-8** (`--encoding=UTF8 --locale=C`), and migrations refuse a non-UTF-8 database | Found while testing: on this machine initdb picked WIN1251, which can't store Greek or emoji. **The existing local dev cluster (`.pgdata/cluster`) is WIN1251 and must be recreated** before `npm run dev:all` starts again; it holds only test data. | — |
| T-31 | **Lifecycle rules as written in §9.3:** only a posted transaction can be edited, voided or deleted; voided and deleted ones can only be restored. Restoring re-checks the ledger rules (for example an archived account, LR-14), and a deleted transaction older than 30 days can't be restored | Follows the approved lifecycle table exactly. | — |

---

## Stage 3 · Ledger core, login and isolation (started 2 Nov 2026)

### Summary

| Piece | Status |
|---|---|
| Project skeleton (npm workspaces, TypeScript, Vitest) | ✅ Done |
| Domain module: money, dates, ledger rules, builders, metrics, Safe to Spend (Stage 3 subset) | ✅ Done |
| Golden tests as data, run in memory and against PostgreSQL | ✅ 22 scenarios pass at both levels |
| Database: migration 0001 (ledger core, constraints, row-level security) | ✅ Done, 19 attack tests pass |
| Git repository and GitHub | ✅ Done (private repository kirilshishkovvvv-hub/fintrack) |
| Migration 0002: auth tables in their own schema | ✅ Done |
| Login with Better Auth: Argon2id, required email verification, sessions, rate limits, 2FA plugin | ✅ Done |
| API: workspaces, accounts, categories, transactions, transfers, summary | ✅ Done, 14 API tests pass |
| Idempotency keys, CSRF origin check, problem-details errors | ✅ Done |
| Isolation in two independent layers (application filter and row-level security) | ✅ Done, each layer mutation-tested on its own |
| Web app (Next.js) mounting the API, sign-in and sign-up screens | ⏳ Stage 4 |
| Staging on Render | ⏳ Needs your Render account |

**Test run (3 Nov 2026):** 114 passed, 10 todo, 0 failed. Type check clean.

### Added on 3 Nov 2026: login and the API

- **Login (FR-01), tested through real sign-up, verification and sign-in:**
  - passwords under 12 characters are rejected;
  - an unverified account can neither sign in nor reach financial data (AC-01.1);
  - signing up with an existing email looks the same as a new sign-up (AC-01.2);
  - passwords are stored as Argon2id hashes with the OWASP settings;
  - every financial endpoint answers 401 without a session;
  - a signed-out session stops working on its next request (AC-01.4).
- **The ledger through the API:**
  - GT-03 gives the Stage 1 numbers;
  - a second workspace-creation call returns the existing workspace (A-5);
  - future dates, unknown references and extra fields such as a made-up `balance_minor` are rejected (Stage 2 §9.3).
- **Idempotency:**
  - a retried request returns the stored result;
  - five simultaneous duplicates create one transaction;
  - reusing a key with a different request is refused;
  - a write without a key is refused.
- **CSRF:** state-changing requests from another origin, or with no origin, are refused.
- **GT-59 through the API:** user B can't read user A's transaction (404), can't post to A's category or from A's account, sees only their own accounts and figures, and A's figures are unchanged afterwards.
- **GT-70:** a USD workspace gives identical numbers, labelled USD.
- **Two independent isolation layers, both mutation-tested:**
  - with row-level security switched off, the application filter alone still keeps users apart;
  - with no application filter, the database tests show row-level security alone does.
  - The first mutation run showed that only the database was protecting the data, so the explicit filter was added (T-15).

### What the tests prove

- **Golden scenarios** GT-01 to GT-08 (except GT-05, which is a unit test), GT-11 to GT-15, GT-17 (ledger part), GT-18, GT-19, GT-21 to GT-27 (GT-25 without the alerts) give the exact Stage 1 numbers, both in memory and after a round trip through PostgreSQL.
- **GT-05** (split rounding) is covered by unit tests, plus a property test over random splits.
- **Ledger rules** LR-01, LR-02, LR-04, LR-05, LR-06, LR-14, LR-15 and LR-18, and the §5.4 posting patterns, each have a test that a breaking transaction is rejected.
- **Property tests** (random operation sequences): every built transaction balances; the Net Worth identity always holds; voided and trashed transactions never count; Safe to Spend properties P1, P2 and P4.
- **A deliberate one-cent error** in GT-03 made the suite fail, confirming the golden tests really assert.
- **Database guarantees**, tested by attacking them directly as the application role:
  - unbalanced, one-line and empty transactions are rejected at commit;
  - zero and out-of-range amounts are rejected;
  - future dates, dates before an account's opening date, archived accounts and misuse of equity are rejected;
  - a failure leaves nothing behind;
  - voiding removes postings from balances at once;
  - workspace B sees none of workspace A's rows, can't change them, can't insert into A, and can't post to A's accounts even knowing their IDs;
  - with no workspace context, nothing is visible;
  - the currency is locked once transactions exist;
  - the application role can't delete transactions or history;
  - audit events and versions are append-only;
  - a posting's currency must match its workspace.

### Still marked "todo" in the test run (each waits for its feature)

GT-09 and GT-10, plus the import parts of GT-39 and GT-71 and the export and search parts of GT-59 (Stage 4). GT-16, GT-20, the Safe to Spend part of GT-17 and the alert part of GT-25 (Stage 5).

### Technical choices made inside the approved design

| # | Choice | Why | Reversible? |
|---|---|---|---|
| T-1 | **TypeScript 6.0.3**, not 7.0 | 7.0 is the new native compiler; 6.x keeps compatibility with Next.js and tooling. | Easy |
| T-2 | **Vitest 4.1.12** and other dependencies pinned to versions at least two weeks old | Avoids brand-new releases. | Easy |
| T-3 | **Migrations are hand-written SQL files**; the Drizzle query layer (AD-09) is added with the API | The first migration is almost all constraints, triggers and row-level security, which AD-09 already said would be hand-written SQL. | Easy |
| T-4 | **node-postgres (`pg` 8.23.1)** as the database driver | Mature and widely used; works with Drizzle later. | Easy |
| T-5 | **embedded-postgres 18.4** for local development and tests only | A real PostgreSQL with no system install (your choice). It has one maintainer, which is acceptable for a test-only tool; production uses Render's managed PostgreSQL. Its Windows postinstall script was reviewed: it does nothing on Windows, so it wasn't enabled. | Easy |
| T-6 | **User IDs are text** in the financial tables | Better Auth uses string IDs. | Easy before launch |
| T-7 | **Transaction kind `split`** is in the schema | Stage 1 §5.4 defines the "general split" kind (GT-21), but the Stage 2 table list missed it. This corrects an omission; it isn't a new rule. | — |
| T-8 | **Safe to Spend is a Stage 3 subset**: spendable balances − card reserve − protected reserve | Planned items and goal allocations don't exist yet. The function refuses inputs it can't handle rather than guessing, and the full §7 formula arrives in Stage 5. | — |
| T-9 | **Golden scenarios are data files** shared by every test harness | So the in-memory, database and later API runs assert identical numbers (Stage 2 §12.2). | — |
| T-10 | **Sessions:** a 30-minute idle timeout through Better Auth's sliding expiry (refreshed at most every 5 minutes), plus our own check of the 30-day absolute limit (AD-14) | Better Auth has no absolute limit of its own. "Keep me signed in" (14 days) comes with the sign-in screen in Stage 4. | Easy |
| T-11 | **Login throttling:** Better Auth's database-backed rate limits, with 5 sign-in attempts per 15 minutes per source address | Covers BR-01.3 per source; the per-account progressive delay is still to do (Stage 4). | Easy |
| T-12 | **Workspace creation:** the first `POST /workspaces` after sign-in (onboarding picks EUR or USD); a lock ensures one workspace per user | Registration itself can't ask for the currency; this keeps BR-02.1 and A-5. | Easy |
| T-13 | **Default categories:** an English list with language keys, in `packages/api/src/seed.ts` | Based on FR-05/BR-05.2. **Please review the list**; it's easy to change before launch. | Easy |
| T-14 | **Auth tables** in their own `auth` schema, as generated migration 0002, with an `auth_app` role; the financial role has no access | Keeps credentials apart from financial data and versions the schema like any other. | Moderate |
| T-15 | **Every query filters by workspace explicitly**, in addition to row-level security | Stage 2 requires two independent layers (FR-02, AD-05); see the mutation tests above. | — |
| T-16 | **The API is a framework-independent Fetch handler** that Next.js mounts in Stage 4; for now, services load a workspace's transactions per request | Fully testable without a web server. Database-side totals will be added before the NFR-03 performance test. | Easy |
| T-17 | **Breached-password check** through Better Auth's Pwned Passwords plugin (k-anonymity, AD-19), switched off only in automated tests | No network calls during tests. | Easy |
| T-18 | `memberships.user_id` has no foreign key to the auth user yet | It gets one with the account-deletion flow in Stage 4, so deletion order can be designed first. | Easy |

### Open items for you

1. **Review the default categories** (T-13) when convenient.
2. **A Render account**, when we reach staging. The free Hobby workspace is enough for staging; the Pro plan is only for production.
