# Progress log

The running record of implementation work: what was built, what was verified, and every technical choice made inside the approved design (Stage 1 spec and Stage 2 architecture). Anything that would change an approved rule or decision is **not** made here. It goes to you for approval first.

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
