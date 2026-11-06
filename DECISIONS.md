# Decisions

The important decisions, with why and their status. Full reasoning: Stage 1 §2 and §14, Stage 2 §14 and Annex R. Smaller technical choices (T-1 to T-89) are in [docs/progress-log.md](docs/progress-log.md); only those that matter across the project appear here.

**Status:** ✅ confirmed by the user · 🔧 provisional: my technical choice inside the approved design, reversible · ❓ unresolved.

## Unresolved

| ID | Question | Recommendation | Who |
|---|---|---|---|
| D-1 | **AD-09 approved Drizzle; the code uses raw parameterized SQL.** T-3 said Drizzle would come with the API. It never did, and I didn't flag that | Approve the raw SQL: it's working and tested, and it's close to what the row-level security and triggers need. Adding Drizzle now means rewriting every store with no gain in correctness. **Not changed without your OK** | User |
| D-4 | Should the plain, unencrypted export stay available? | Yes, labelled, because spreadsheets need it | User |
| D-5 | Final product name and domain | Before launch: passkeys bind to the domain, and ads need a trademark check | User |
| D-6 | OK to record TR-01 to TR-20 (Annex L) in the Stage 1 spec | Yes | User |
| D-7 | OD-17 (multiple workspaces), OD-18 (USD display per locale), OD-04 (matching tolerances, to validate on real data) | Non-blocking | Later |
| D-8 | Open-banking provider for release 1.1 (AD-23) | Quotes and a contract needed | User, later |
| D-10 | **The approved documents conflict.** BR-03.6 lets an account's type change within its class; Stage 2 §9.2 says type and class are immutable once postings exist | Keep BR-03.6, as built: it changes no balance, and users correct a wrong type. Fix the Stage 2 line | User |
| D-11 | BR-05.6: import maps descriptions to payees through user-editable rules. Stage 2 has no table or route for this, so it isn't built (T-59) | Build it with the rules work in Stage 5 (FR-16 rules), or after real bank files show the need | User |
| D-12 | BR-05.4 allows deleting an unused category. Stage 2 §9.2 has no such route, so only archive and merge exist | Accept it for the first release: archiving does the same job for the user | User |
| D-9 | Legal: LQ-01 to LQ-08, LQ-10. Includes keeping or erasing consent records after deletion, and whether the kept audit trail is personal data | A lawyer before launch | Lawyer |

## Product

| ID | Date | Decision | Why | Status |
|---|---|---|---|---|
| C-1 | Before 2 Nov 2026 | Multi-user with strict isolation; households later | Commercial product | ✅ |
| C-3 | Before 2 Nov | Goals both linked to accounts and virtual, with no double counting | Real use needs both | ✅ |
| C-5 | Before 2 Nov | Safe to Spend is a documented formula, not a sum of balances | Core feature | ✅ |
| §7.4 F3 | By 2 Nov | The approved formula, including AM-1 and option (c) | See §7.12 | ✅ |
| CUR-1 | 2 Nov | EUR or USD, one per workspace, locked after the first transaction. **Supersedes** C-2's original wording and the brief's "EUR only". BGN dropped | User decision | ✅ |
| MKT-1 | 2 Nov | EU first; bank connection in release 1.1. **Supersedes** the Bulgaria-only scope | User decision | ✅ |
| MKT-2 | 2 Nov | 7 languages switched on one by one; no Russian; English only at launch. **Supersedes** MKT-1's list | User decision | ✅ |
| AP-15 | 2 Nov | Import work runs right after Stage 4 | Real use needs it early | ✅ |
| AP-07 | 2 Nov | Contingency cut order (§12.1), keeping financial correctness | Scope risk | ✅ |
| GAP-1 to 6 | 2 Nov | Rule gaps: trash returns an occurrence to Planned; a refund outlives a purged original; ±999,999,999,999 limit; 10-second undo; 7-day deletion window; second save rejected | Spec was silent | ✅ |
| OD-05 to 07 | 2 Nov | Trash 30 days; audit 24 months; erase within 30 days, backups 35 | Defaults; lawyer to confirm | ✅ default |
| Annex L | 2 Nov | Legal and trust list, TR-01 to TR-20, mapped to stages | User's list | ✅ list; recording in Stage 1 is D-6 |
| Visuals | 2 Nov | Comparable to leading apps, original, usable in ads | User decision | ✅ |
| PK-1 | 4 Nov | Passkeys in the first release. **Supersedes** "later" in §3.6; password stays as backup | User decision: easier sign-in | ✅ |
| D-3 | 4 Nov | Finish the missing Stage 4 items before Stage 5 | User decision | ✅ |
| D-2 | 5 Nov | Re-importing an export is a Should (AC-17.4), not a Stage 4 exit criterion. **Amends** Stage 1 §12.2, where it is EX-1, because Stage 1 has its own D-2 | User decision: the two conflicted | ✅ |
| Encrypted export | 4 Nov | AES-256 export with the customer's own password as the main path | User's concern about unprotected bank data | ✅ (detail: D-4) |

## Architecture

| ID | Decision | Why | Status |
|---|---|---|---|
| AD-01, 03 | TypeScript modular monolith on PostgreSQL | One language; constraints and row-level security | ✅ 2 Nov |
| AD-02 | Render, Frankfurt | Long-running processes, one EU region | ✅ 2 Nov; not set up |
| AD-04 | Better Auth, self-hosted, Argon2id | Data stays in the EU; immediate revocation | ✅ 2 Nov |
| AD-05 | Application checks **and** forced row-level security **and** composite foreign keys | FR-02 needs two independent layers | ✅ 2 Nov |
| AD-06 | Money as `BIGINT` minor units | Exact | ✅ |
| AD-07, 08 | Per-workspace lock; idempotency keys in the same database transaction | No races; retries are certain | ✅ 2 Nov |
| AD-09 | Drizzle plus reviewed SQL migrations | Readable SQL | ✅ 2 Nov, **not followed for queries: D-1** |
| AD-10 | Postgres-backed job queue in a worker | No extra service | ✅; not built |
| AD-11 to 13 | Sentry EU; Scaleway email, SES fallback; Hetzner daily backups | EU; independent copy | ✅ 2 Nov; not set up |
| AD-14 | Idle 30 minutes, 14 days if chosen, 30 days at most | Fills gap X-3 | ✅ 2 Nov |
| **AD-15** | **Optional 2FA ships at launch. Supersedes A-6 ("Should")** | Resolves contradiction X-2 | ✅ 2 Nov; screens built 4 Nov. My 4 Nov note that this was the user's call was wrong |
| AD-16 | Authorization in services and the database, never in middleware | CVE-2025-29927 | ✅ |
| AD-17 | No cached summaries unless NFR-03 tests fail | Nothing can drift | ✅; measured 6 Nov: the targets are met without one (T-83) |
| AD-18 | UUID version 7 | Unguessable; good for indexes | ✅ |
| AD-19 | Pwned Passwords k-anonymity check | Only a hash prefix leaves the server | ✅ 2 Nov |
| AD-20 | Currency enforced by the database | CUR-1 | ✅ |
| AD-21 | No tracking SDKs; strict browser security policy | Privacy | ✅ 2 Nov |
| AD-22 | Message catalogues, English source, professional translation | MKT-1 | ✅ phased |
| AD-23 | Licensed open banking in 1.1; no scraping | Law and trust | ✅ provider open |

The register's heading in Stage 2 §14 still says "None is approved until you say so"; that text is out of date, and each row's status is what counts.

## Technical choices that changed something approved

Inside the design, and reversible unless noted. Each is in the progress log.

| ID | Choice | Differs from | Status |
|---|---|---|---|
| T-3 | Hand-written SQL migrations | AD-09 wording; see D-1 | 🔧 |
| T-8 | Safe to Spend subset until Stage 5 | §7.4 in full | 🔧 temporary |
| T-29, T-40 | `fin_maintenance` role; the purge uses row-level security per workspace | Extends Stage 2 §6.3 | 🔧 |
| T-32 | Reconciliation items per transaction; `postings.reconciliation_id` dropped | Stage 2 §5 table | 🔧 harder to reverse |
| T-33 | Reconciliation preview and finish in place of a server-side draft | Stage 2 §9.2 routes | 🔧 |
| T-38 | Idle limit enforced through our own `lastActiveAt` | Better Auth's expiry alone | 🔧 |
| T-41 | `memberships.user_id` has no foreign key to the auth user. Resolves T-18 | — | 🔧 |
| T-43 | AES-256 ZIP written with Node's crypto; 12-character minimum because the format's key derivation is weak | Stage 2 §11.5 extended | 🔧 |
| T-44 | Two-step import upload | Stage 2 §9.2 single call | 🔧 |
| T-46 | Accepting a pair turns the existing entry into the one transfer; undo restores it | BR-16.5 detail | 🔧 |
| T-51 | Passkey sign-ins use the 30-minute idle limit | — | 🔧 |
| T-57 | How AC-04.5's total treats transfers and voided lines | AC-04.5 wording | 🔧 |
| T-60, T-63 | Added routes: account detail, opening balance, reorder | Stage 2 §9.2 | 🔧 |
| T-61 | A date-only change also breaks a reconciliation | E-03 wording | 🔧 |
| T-64 | `PATCH /me` not built while only English is on | Stage 2 §9.2 | 🔧 temporary |
| T-70, T-71 | One-off items are rules with frequency `once`; a template's funding side is the sum of its lines | Stage 2 §5 | 🔧 |
| T-72 | Occurrences generated on read until the worker exists | Stage 2 §4 (AD-10) | 🔧 temporary |
