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
| Git repository and GitHub | ⏳ Blocked: Git needs an administrator prompt on your computer |
| Login (Better Auth), workspaces API, isolation tests through the API | ⏳ Next |
| Accounts, categories and transactions API | ⏳ Next |
| Staging on Render | ⏳ Needs your Render account |

**Test run (2 Nov 2026):** 100 passed, 10 todo, 0 failed. Type check clean.

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

GT-09 and GT-10 (Stage 4), GT-16, GT-20, the Safe to Spend part of GT-17 and the alert part of GT-25 (Stage 5), and GT-39, GT-59, GT-70 and GT-71 through the API (later in Stage 3).

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

### Open items for you

1. **Git**: the installer needs an administrator prompt, and both attempts were cancelled before the prompt was approved. Either approve the prompt when I retry, or install Git for Windows yourself from git-scm.com.
2. **GitHub**: once Git works, create an empty **private** repository and tell me its URL. You'll sign in yourself when I push the first time.
