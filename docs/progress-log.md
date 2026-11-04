# Progress log

The running record of implementation work: what was built, what was verified, and every technical choice made inside the approved design (Stage 1 spec and Stage 2 architecture). Anything that would change an approved rule or decision is **not** made here. It goes to you for approval first.

---

## Stage 4 · Core application (3 to 4 Nov 2026)

**Status: built.** Every item below is done, apart from the limits listed in each section. Exit criteria (Stage 1 §12): GT-40 to GT-45 pass, export works, usable at 360 px. AC-17.4 (re-importing an export) is a Should and isn't built.

### Summary

| Piece | Status |
|---|---|
| Next.js web app with the API mounted at `/api/*`, security headers, no telemetry | ✅ Done |
| Translations through next-intl; English switched on (MKT-2); every visible text in `apps/web/messages/en.json` | ✅ Done |
| Consent records at sign-up: terms, privacy notice, 18+ (never pre-ticked), optional marketing (Annex L items 6 and 17) | ✅ Done, tested |
| Screens: sign-up, email verification, sign-in, onboarding (EUR or USD), dashboard, add account, add transaction, activity list | ✅ Done, checked in the browser |
| Local development: `npm run dev:all` starts a local database and the web app; security emails print to the server log | ✅ Done |
| Edit, void, delete to trash, restore and undo, with a version history per transaction; 30-day trash purge | ✅ Done, tested, checked in the browser |
| Reconciliation with adjustments and locks, quick balance update, archive and merge (GT-40 to GT-42, GT-45) | ✅ Done, tested, checked in the browser |
| Export of all data: CSV and JSON in a ZIP, with a recent sign-in required (FR-17) | ✅ Done, tested, checked in the browser |
| Activity log (audit view), including sign-ins and failed sign-ins | ✅ Done, tested, checked in the browser |
| "Keep me signed in" (14 idle days), per-account login slowdown | ✅ Done and tested |
| Account deletion: request, 7-day cancel window, purge | ✅ Done and tested; request and cancel checked in the browser |
| CSV import (moved here from Stage 7, AP-15) | ✅ Done, tested, checked in the browser; matching to planned bills joins with Stage 5 |
| End-to-end browser tests (Playwright), with accessibility checks | ✅ Done: 11 journeys, on desktop and at 360 px |
| Passkeys (your addition, PK-1) | ✅ Done and tested with a virtual device; **real devices still to try** |

**Test run (4 Nov 2026, night):** 229 passed, 10 todo, 0 failed, plus 22 browser tests passed (`npm run e2e`, 11 journeys × desktop and phone). Both type checks clean, and a production build (`next build`) succeeds.

### Added on 4 Nov 2026 (night): browser tests and passkeys

- **Browser tests** run in real Chrome against a throwaway database:
  - sign-up through to Safe to Spend, then edit, undo, delete and restore;
  - import, review, confirm and undo;
  - reconcile with an adjustment, lock and unlock;
  - merge categories and read the activity log;
  - encrypted export, deletion, cancel, and deletion through to the purge;
  - keyboard-only sign-in;
  - five passkey journeys.
- **Accessibility:** axe (WCAG 2.1 A and AA) passes on all the main screens, with light colours on desktop and dark at 360 px. Automated checks catch only some problems, so this doesn't replace a manual review or a screen-reader test.
- **Passkeys (PK-1):** add, name and remove them under "Your data and privacy"; sign in with one; use one to confirm a sensitive action.
- **A weakness in the passkey plugin, fixed:** it doesn't require the face, finger or PIN check, so a key that was only tapped would have been accepted. The server now refuses that, both when adding and at sign-in. Each refusal has a test that fails when the check is removed (mutation-tested). The first version of the sign-in test didn't prove it, because Chrome refused first; it was rewritten.
- Adding or removing a passkey needs a recent sign-in, and writes an activity-log entry and an email notice. Passkeys go with the account at the purge.
- **Not checked:** real phones, Windows Hello or a real fingerprint reader. All tests use Chrome's virtual device. **To try on real devices once there's a staging address.**
- **Passkeys belong to the web address.** Moving the app to another domain later would stop every existing passkey working, so **the final domain should be settled before launch.** "Fintrack" is still a working name.
- **Noted, not built:** 2FA has a backend but no screens. Stage 1 lists it as a Should and Stage 2 lists its journey as critical. The export doesn't yet list a user's passkey names.

### Added on 4 Nov 2026 (late evening): CSV import

- **The flow:** upload → the format is detected → the user checks the columns and a preview → rows are classified → review and decide → confirm, all or nothing → undo if needed. The file is never stored; only parsed rows are (BR-16.7).
- **Tested, with the Stage 1 numbers:**
  - GT-35 and AC-16.1, AC-16.2: identical rows get ordinals, re-imports add nothing, Current 937.50, Safe to Spend 1,037.50;
  - GT-36: possible duplicates need a decision; linking gives one transaction, keeping both gives two and is audited;
  - GT-09: both sides of a transfer make exactly one transaction, and Income and Expenses stay 0;
  - GT-38 (ledger part) and AC-16.4: undo restores every figure; it's blocked while reconciled, listing the locked transactions, and edited transactions are listed for confirmation;
  - GT-39 (b): an 800-row confirmation interrupted at row 301 saves nothing; a retry saves 800; another changes nothing;
  - GT-71: rows in USD or BGN are rejected, and a file with no currency column needs the user's confirmation;
  - AC-16.5: Windows-1251 with comma decimals reads correctly;
  - 2,000 rows are classified and confirmed in under 10 seconds (NFR-03), on this development machine;
  - the 5 MB and 10,000-row limits, and ISO-5 (another user gets 404).
- **The database itself** refuses a second import of the same fingerprint and ordinal, and a second claim on a transaction.
- **Checked in the browser:** a Bulgarian Windows-1251 file with a title line and a total line. A bad date and a row dated tomorrow were rejected, the transfer was accepted, confirm moved Current from €2,233.17 to €2,308.17, and undo returned it exactly.
- **Waiting for later:**
  - matching rows to planned bills (GT-37, part of GT-38): Stage 5, listed as "todo" in the test run;
  - Should items not built: the running-balance check, Excel files, value date, editing a saved format (saving again under the same name replaces it);
  - payee rules (BR-05.6): for now a category is suggested from earlier transactions with the same text;
  - the Uncategorized total on the dashboard (AC-05.3) joins with the reports.
- **Not tested on real bank files.** All test files are ones I wrote. Stage 2 calls for anonymized files from banks in the launch countries, and these would show what the format detection misses. Every detected setting can be changed on screen.

### Added on 4 Nov 2026 (evening): encrypted export (your request)

- The export screen now leads with a password: the file is encrypted with AES-256 (WinZip AE-2 format). The plain download stays as a clearly labelled second option, for spreadsheets.
- The password must be at least 12 characters, is used once and is never stored.
- **Checked:** Windows' built-in `tar` (an independent implementation) opens the file with the right password, refuses a wrong one and writes no readable data. The file contains no readable text and no checksum of the content, and each export uses a new salt.
- **Not checked:** opening it in 7-Zip (not installed here) or in Windows Explorer and Mac's Archive Utility, so the screen says they "may not" open it. **To test on real computers before launch.**
- **Known limit:** the ZIP standard fixes the key derivation at 1000 PBKDF2 rounds, which is low, so a weak password could be guessed by someone who has the file. That's why 12 characters is the minimum.

### Added on 4 Nov 2026 (evening): activity log, sessions, login slowdown, account deletion

- **Activity log:** what happened and when, 50 at a time, never amounts or descriptions; another user's events never appear.
- **Sessions (AD-14):** 30 idle minutes by default, 14 idle days only if "Keep me signed in" is ticked, and 30 days at most either way. Tested by aging sessions in the database.
- **Login slowdown (BR-01.3, AC-01.5):** from the 5th failure within 15 minutes, every attempt must wait 30 seconds, doubling up to 15 minutes, even with the right password. An unregistered address behaves identically, and the table stores no addresses.
- **Account deletion (§8.6, GAP-5, AC-01.6):**
  - it needs a recent sign-in, offers the export first and requires a tick;
  - every session ends, and a notice is emailed;
  - for 7 days only cancelling, exporting and reading the status work;
  - the purge then removes every row and the login, leaves other users' figures untouched, and frees the address.
- **Checked in the browser:** the sign-in screen, the activity log, and deleting, signing back in and cancelling. **Not clicked through:** ticking "Keep me signed in" (API tests only), and the purge (it has no screen).

### Open points from this work

1. **Nothing runs the purges on a schedule yet.** Both the 30-day trash purge and the deletion purge are tested functions waiting for the background worker (Stage 8). **They must be scheduled before launch**, or the promises shown on screen wouldn't be kept.
2. **A user who never finished onboarding has no workspace and can't delete their account in the app.** To fix with the deletion route or manual requests (Annex L item 20) before launch.
3. **Audit log retention (24 months, PRV-06)** isn't implemented; it joins the worker.
4. **For the lawyer (LQ-08):**
   - consent records are erased with the account, though proof of consent may need keeping for a time;
   - the kept audit trail holds a random user ID that no longer leads to anyone, which I treat as not personal data;
   - the deletion notice needs final email wording.

### Added on 4 Nov 2026: browser check of reconciliation, and export

- **Checked in the browser:**
  - GT-40's figures: ticked balance €2,251.17, statement €2,243.17, difference +€8.00, adjustment −€8.00;
  - unticking an item updates the difference (+€608.00), and finishing locks every item;
  - unlock asks for confirmation; after an edit the reconciliation shows "Needs redoing" at −€10.00 (GT-42);
  - a cash count, archiving an account at zero, and merging a category;
  - Greek text and emoji are stored and shown correctly.
- **Found and fixed:** opening balances could be voided or deleted on their own, against E-01. Six pages stayed on "Loading…" if a load failed; they now show an error with a retry.
- **Export (AC-17.1 to AC-17.3):**
  - accounts, categories, transactions (one row per line) and reconciliations as CSV, UTF-8 with a BOM, plus a complete data.json with a schema version;
  - each transaction's lines sum to 0, balances match the app, and a description starting with "=" is exported as inert text;
  - it needs a sign-in within 10 minutes (BR-01.5), and the screen asks for the password again if not; each export is audited;
  - another user's data never appears in it, and Windows' own unzip opens the file.
- **Not in the export yet:** budgets, goals, rules, payees and tags, because they don't exist yet. They join it with their stages.

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
| T-36 | **The ZIP is written by a small function using Node's built-in compression**, with no new dependency | Fewer third-party packages (Annex L item 7). Checked with Windows' and Info-ZIP's unzip. | Easy |
| T-37 | **"Recent sign-in" is measured from when the session signed in**, not from Better Auth's own freshness check | Sessions slide with activity, so the time of the last refresh wouldn't prove the user recently entered a password. | Easy |
| T-38 | **Idle limits are enforced by our own check against a new `lastActiveAt` session column.** Better Auth has one expiry for all sessions, and slides it before returning the session. Without "keep me signed in", the cookie also ends when the browser closes | Refines T-10; the approved limits (AD-14) are unchanged. | Moderate |
| T-39 | **The login slowdown is a delay, capped at 15 minutes, keyed by an HMAC of the email.** The per-source limit stays as in T-11 | A permanent lock would let anyone shut a person out. | Easy |
| T-40 | **The purge sets the target workspace and uses the existing row-level security**, as `fin_maintenance` with delete rights (migration 0006). A row with no personal data stays as the audit trail's reference | No role can delete across workspaces in one statement; a test proves it. | Moderate |
| T-41 | **Resolves T-18: `memberships.user_id` stays without a foreign key to the auth user.** The purge removes them in order, and a test checks nothing is left | Keeps the auth and financial schemas independent. | Easy |
| T-42 | **"Your data and privacy" page** groups export, activity log and deletion; it's reached from Accounts | Makes the rights in Annex L easy to find. | Easy |
| T-43 | **AES-256 ZIP (AE-2) written with Node's built-in crypto**, no new dependency. Encrypted is the main path and plain the labelled alternative | Your request. A user-chosen password means we can't read the file and can't recover it; exporting again is the recovery. Extends the Stage 2 §11.5 format without changing its contents. | Easy |
| T-44 | **Two-step upload:** the preview is stateless and the browser sends the file again to create the batch, in place of the single multipart call in Stage 2 §9.2 | The server holds no file between steps (BR-16.7). | Easy |
| T-45 | **Lines with an unusual column count are left out and counted on screen**; the date format DD/MM wins when a file fits both, and the preview shows the dates | EU-first (MKT-1), and nothing vanishes or is guessed unseen. | Easy |
| T-46 | **A transfer can be suggested two ways:** another account named as a whole word (4+ letters) in the description, or an opposite income or expense on another account within 3 days. Accepting the second turns that entry into the one transfer, and undo restores it | BR-16.5: never income plus expense. | Moderate |
| T-47 | **Suggested transfers and possible duplicates need a decision; nothing is applied silently.** The second side of an existing transfer is linked by default, but it's shown and can be changed | M-5, GT-09. | Easy |
| T-48 | **"Uncategorized" and "Uncategorized income" are created the first time they're needed** | FR-05 line on imports; workspaces that never import don't see them. | Easy |
| T-49 | **Browser tests use the installed Chrome**, not a downloaded browser, on a dev server at port 3100, and need `npm run dev:all` stopped. Playwright 1.64.1, axe 4.14.0 | Nothing extra to download. CI will need its own browser. | Easy |
| T-50 | **@better-auth/passkey 1.7.11, with @better-auth/core, better-call and @better-fetch/fetch pinned to match better-auth 1.7.11.** It adds @simplewebauthn to the dependency list (Annex L item 7) | npm otherwise picks newer, incompatible versions. | Easy |
| T-51 | **Passkey sessions follow the normal idle limit** (30 minutes); "Keep me signed in" is offered with the password only | The safer default. Easy to extend. | Easy |
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

### Added to the plan by you

- **Passkeys (your decision, 4 Nov 2026):** sign-in with Face ID, Windows Hello or a fingerprint, on phones and computers. The device checks the face or finger; we store no biometric data. Password stays as the backup. This moves passkeys from "later" (Stage 1 §12) into the first release. **To be built right after CSV import and the browser tests, within Stage 4.**

### Open items for you

1. **Review the default categories** (T-13) when convenient.
2. **A Render account**, when we reach staging. The free Hobby workspace is enough for staging; the Pro plan is only for production.
