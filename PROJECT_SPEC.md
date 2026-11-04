# Project specification (summary)

This is the short, always-current overview. **Where it differs from the detailed documents, they win; report the difference rather than picking one silently.**

| Topic | Source of truth |
|---|---|
| Financial rules, requirements, golden tests | [docs/stage-1-specification.md](docs/stage-1-specification.md) (approved 2 Nov 2026) |
| Architecture, schema, API, security, legal list | [docs/stage-2-architecture.md](docs/stage-2-architecture.md) (approved 2 Nov 2026) |
| Decisions and their status | [DECISIONS.md](DECISIONS.md) |
| What exists now | [PROGRESS.md](PROGRESS.md) |

## Purpose and goals

"Fintrack" (a working name) is a commercial, multi-user personal finance tracker for ordinary people with no accounting knowledge (C-8). Its central feature is **Safe to Spend**, a documented figure that is never just the sum of balances (C-5). Numbers must be exactly right, with zero tolerance for financial errors (NFR-01).

- **Market:** EU first; the US later (MKT-1).
- **Languages:** built for en, bg, de, es, it, fr, el and switched on one at a time; **English only at launch** (MKT-2).
- **Currency:** EUR or USD, one per workspace, locked after the first transaction (CUR-1).
- **Delivery:** gated stages 1 to 9 (order in Stage 1 §12.2). See the working agreement below.

## Requirements

Full text: Stage 1 §3.4 (FR-01 to FR-24) and §3.5 (NFR-01 to NFR-12). Scope: §3.6 and §12.1.

| FR | Topic | Priority |
|---|---|---|
| 01, 02 | Accounts and login; isolation between users | Must |
| 03, 04, 06 | Financial accounts; transactions; splits | Must |
| 05 | Categories and payees (tags are Should) | Must |
| 07 to 10 | Budgets; recurring items; goals and allocations; cards and debts | Must (goal projections are Should) |
| 11, 12, 14, 15 | Upcoming list; Safe to Spend; dashboard; core reports | Must |
| 16 to 19 | CSV import; export; reconciliation; history, undo and audit | Must (Excel and the audit viewer are Should) |
| 21 to 24 | Responsive layout; languages; currency; future-proofing | Must |
| 13, 20 | Projection; in-app notifications | Should |

Added after approval: passkeys in the first release (PK-1). Optional 2FA at launch (AD-15, which supersedes assumption A-6's "Should").

Key targets (NFR-03): saving a transaction p95 < 500 ms; dashboard p95 < 1.5 s and reports p95 < 3 s at 50,000 transactions; 2,000-row import < 10 s. Accessibility: WCAG 2.1 AA (NFR-08). Browsers: last 2 versions, iOS Safari 16+ (NFR-09).

**Release 1.1, not the MVP:** bank and card connection through a licensed EU open-banking provider (AD-23).

## Architecture and stack

A TypeScript modular monolith on one PostgreSQL database in Frankfurt. Detail: Stage 2 §3, §4.

| Layer | Choice | Where |
|---|---|---|
| Financial rules | Pure TypeScript, no I/O | `packages/domain` |
| Database | PostgreSQL, hand-written forward-only SQL migrations, row-level security | `packages/db` |
| API | Framework-free Fetch handler under `/api/v1`, Zod strict schemas | `packages/api` |
| Login | Better Auth in our own database, schema `auth` | `packages/api/src/auth.ts` |
| Web | Next.js, React, next-intl | `apps/web` |
| Golden tests | Stage 1 scenarios as data | `packages/golden` |
| Browser tests | Playwright, axe | `e2e` |
| Planned hosting | Render Frankfurt; Postgres-backed job queue in a worker; Scaleway email; Sentry EU; Hetzner backups | Not set up yet |

## Database

Full design: Stage 2 §5 and §6. Migrations: `packages/db/migrations`, 0001 to 0008.

| Tables | Purpose |
|---|---|
| `fin.workspaces`, `fin.memberships` | Ownership boundary (one workspace per user in the MVP, A-5), currency, reserve, deletion status |
| `fin.ledger_accounts`, `fin.accounts`, `fin.categories`, `fin.payees` | Everything money can post to. Accounts and categories extend ledger accounts |
| `fin.transactions`, `fin.postings` | The ledger: one balanced event and its signed lines. Postings copy date and status through a cascading foreign key |
| `fin.transaction_versions`, `fin.audit_events` | History and audit, append-only |
| `fin.idempotency_records` | Stored answers for retried requests |
| `fin.reconciliations`, `fin.reconciliation_items` | Statements and the transactions they lock |
| `fin.import_profiles`, `fin.import_batches`, `fin.import_rows` | Saved mappings, uploads, parsed rows. The file itself is never stored |
| `fin.consent_records` | Consents with document versions, append-only |
| `auth.*` | Users, sessions, passkeys, 2FA, rate limits, login throttle. The financial role has no access |
| Planned (Stage 5) | Budgets, recurring rules, occurrences, goals, allocations |

**Roles:** `fin_app` (the app; can't delete financial history), `auth_app` (login), `fin_maintenance` (purges, confined by row-level security). In production each login role must belong to only its own role (T-29).

## Business rules and formulas

Ledger rules LR-01 to LR-18 are in Stage 1 §5.2. The ones everything rests on:

- **Balancing (LR-01, LR-02):** every transaction has at least 2 non-zero postings summing to exactly 0 in integer cents, with at least one on a user account. Positive = debit.
- **Displayed balance:** assets and expenses Σ postings; liabilities and income −Σ postings (§2.3).
- **Only actual transactions count (LR-09):** posted, not voided, not trashed. Planned items and allocations have no postings (LR-07, LR-08).
- **No stored balances (LR-16, AD-17):** every figure is derived from postings. Clients send intentions, never postings (Stage 2 §9.3).
- **Money:** integer minor units, `BIGINT`; ±999,999,999,999 per posting (GAP-3); splits use largest remainder; zero lines are rejected; utilization is truncated to one decimal (AM-3).
- **Dates (A-2, A-8):** calendar dates in the workspace time zone; actual transactions can't be in the future or before an account's opening date.
- **Net Worth identity (§2.3, AP-14):** NW(to) − NW(from − 1) = Net Result + OBE + ADJ + VAL + CNV effects.
- **Transaction lifecycle (§9.3):** posted → edit, void, trash, reconcile. Voided and trashed can only be restored. Trash lasts 30 days; undo 10 seconds (GAP-4).
- **Reconciled transactions are locked** until an audited unlock, which marks the reconciliation broken (FR-18). The difference is cleared − statement; the adjustment is −difference.
- **Safe to Spend (§7.4, approved formula F3):** `STS(today) = ELF − UCO − PR − UGA`
  - ELF: balances of spendable accounts, today.
  - UCO: unmatched planned outflows in the window, all overdue ones, the card reserve, and planned expenses on reserved cards.
  - PR: protected reserve. UGA: unspent goal allocations.
  - **Only ELF − card reserve − PR is implemented so far** (T-8). Read §7 in full before Stage 5.
- **Import fingerprint (§9.6):** account + date + amount + normalized description + ordinal among identical rows. Each existing transaction can be claimed once (M-6). A transfer is never income plus expense (BR-16.5).

## UI and workflows

- Wireframes and the Safe to Spend user test plan: Stage 2 §17. The user test must happen **before the Stage 5 UI is finalized**, and hasn't been run.
- Mobile first, usable at 360 px with no sideways scrolling. Quick add: amount first, today by default.
- Every text lives in `apps/web/messages/en.json`, never in components.
- State is never shown by colour alone: sign, icon and text as well. One primary button per screen. Plain wording.
- Visuals should compare with leading money apps but stay original; they'll be used in advertising, with screenshots of the real app and clearly invented data (§17.3).

## Security, privacy and integrity

Full text: Stage 2 §7, §8, §11, and Annex L (TR-01 to TR-20).

- **Isolation in two independent layers:** an explicit workspace filter in every query **and** forced row-level security, plus composite foreign keys. Another user's object answers 404.
- **Writes:** one database transaction per action, a per-workspace lock, idempotency keys on financial POSTs, version checks on edits, balance checks at commit.
- **Login:** Argon2id; passwords of 12+ characters checked against breaches; verified email required; 30 idle minutes, 14 days with "keep me signed in", 30 days at most; a recent sign-in (10 minutes) for export, deletion and passkey changes; login slowdown per account and per source.
- **Passkeys:** the face, finger or PIN check is enforced on our server. No biometric data reaches us.
- **Privacy:** no tracking SDKs, essential cookies only, hosting in the EU, amounts never in logs or the audit trail, self-service export and deletion, minimum age 18.
- **Retention:** trash 30 days; deletion after a 7-day cancel window and within 30 days; audit log 24 months; backups 35 days; abandoned imports 7 days.
- **Legal honesty (Annex L):** no fake reviews, unsupported claims, hidden fees or dark patterns. Don't publish claims such as "bank-level security".

## Rejected: don't change without the user's approval

| Rejected | Why | Ref |
|---|---|---|
| BGN, or any currency beyond EUR and USD | User decision; Bulgaria is on the euro | CUR-1 |
| Russian as a language | User decision | MKT-2 |
| Asking for bank logins, or screen scraping | Licensed open banking only | AD-23 |
| Collecting card numbers or bank passwords | Never | C-9, MKT-1 |
| Tracking or analytics SDKs in the browser | Privacy; keeps the app free of a cookie banner | AD-21 |
| Stored or cached balances | They can drift from the ledger | LR-16, AD-17 |
| Floating-point money | Zero tolerance for errors | NFR-02, AD-06 |
| Authorization in Next.js middleware | A known class of bypass (CVE-2025-29927) | AD-16 |
| Reversal entries instead of voids; automatically recomputed adjustments | They hide errors | LR-11, LR-13 |
| Automatically posting recurring rules | Keeps planned and actual apart | A-7 |
| Recording biometric data | Device-side only | PK-1 |
| The old ZIP password method (ZipCrypto) | Weak | T-43 |
| Copying competitors' layouts, wording or branding | Must be original | §17.3 |

## Working agreement

Agreed with the user on 2 Nov 2026:

- Work through Stages 3 to 7 without a prompt per stage. **Stages 8 and 9 need explicit approval.**
- **Stop and ask** for: a change to an approved rule, design or scope; a financial test that can't pass without changing the spec; production or real user data; anything only the user can do (accounts, passwords, payments, accepting terms, secrets, legal).
- Log technical choices made inside the approved design. Give a one-page summary per stage, decisions first.
- The user isn't a developer: explain plainly, and say what's unverified.
