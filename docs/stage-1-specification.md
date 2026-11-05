# Personal Finance Tracker — Stage 1 Specification

**Status:** approved 2 Nov 2026 · **Stage 2:** approved 2 Nov 2026 (see stage-2-architecture.md) · **Market:** EU first (MKT-1) · **Languages:** English at launch; Bulgarian, German, Spanish, Italian, French and Greek switched on later (MKT-2) · **Currency:** EUR or USD per workspace

This document consolidates Stage 1 Parts 1–4, with every approved amendment merged into the text. The main sections are binding; the appendices keep the reasoning and research.

## One-page summary

**What we're building.** A multi-user personal finance app for non-experts. It shows what you have, where money comes from and goes, how much you can **safely spend**, and whether you're progressing towards goals.

**Key decisions**

| Area | Decision |
|---|---|
| Ledger | Double-entry; integer cents; balances derived, never typed. Planned items never touch real figures (§2, §5) |
| Budgets | Monthly category limits; no rollover; refunds count in the month they arrive (§4) |
| Safe to Spend | Spendable balances − upcoming commitments − protected reserve − goal money. Window runs to the day before payday; expected income is never added (§7) |
| Goals | A whole dedicated account or virtual allocations; progress = real money behind it; "Save for a bill" links a bill to a goal (§8) |
| Cards and loans | Card spending counts at purchase and is reserved in Safe to Spend; payments are transfers; credit limit is never spendable (§5, §7) |
| Import | CSV with duplicate detection, one-to-one matching to plans, and undo (§9) |
| Currency | **EUR or USD, one per workspace**, chosen at signup and locked after the first transaction. No BGN, no conversion, no mixed currencies in the MVP (CUR-1, §10) |
| Precision | Integer cents; one documented rounding rule per operation (§10) |
| Security and privacy | Strict per-user isolation, no bank credentials, EU/EEA hosting, export and deletion; legal points listed for counsel, no compliance claimed (§11) |
| Sequence | Architecture → ledger core → core app → **import** → budgeting and Safe to Spend → reports → hardening → deployment (§12) |

**Changed during review (already merged):** AM-1 (goal money deducted in full) · option (c) for payday · R5 promoted to Must · payday marker replaces the "reliable" flag · matching rules M-1 to M-8 · cashback may be recorded either way · non-working-day setting for paydays · CNV added to the Net Worth identity · golden tests GT-62 to GT-71 added · **EUR or USD per workspace, BGN dropped (CUR-1, 2 Nov 2026)** · **EU-first market, bank connection in release 1.1 (MKT-1); 7 languages switched on in phases, no Russian (MKT-2), 2 Nov 2026**.

**Confirmed corrections (found while consolidating, both caused by option (c)):** GT-33 is 420 / 2,420 (was 400 / 2,400); §7.8 Example 1 is 1,085 (was 785). Details in §15.

**Open but not blocking:** hosting, authentication provider and stack are Stage 2 decisions (OD-01 to OD-03). Other defaults are in §14. Legal questions LQ-01 to LQ-08 must be answered before public launch.

**Top risks:** Safe to Spend comprehension for non-experts (tested with users at the wireframe stage) · matching quality on real bank files · MVP size (contingency cut order in §12.1) · legal readiness before launch.

**Where to look**

| Need | Section |
|---|---|
| Definitions and formulas | §2.3 |
| Feature requirements (FR-01 to FR-24) | §3 |
| Accounting rules (LR-01 to LR-18) and events | §5 |
| Golden tests GT-01 to GT-71 | §6 |
| Safe to Spend | §7 |
| Goals | §8 |
| Data model, lifecycle, matching | §9 |
| Currency and rounding | §10 |
| Security, privacy, legal questions | §11 |
| MVP and sequence | §12 |
| Traceability, open decisions, checklist | §13–§15 |
| Rationale and competitor research | Appendices A and B |

---

## 1. Executive summary

**What the product is:** a multi-user personal finance platform for the EU market, available in 7 languages (switched on in phases), with each workspace in EUR or USD. It answers five questions: what I have, where it comes from, where it goes, what I can safely spend, and whether I'm progressing.

**Key decisions (approved 2 Nov 2026):**

1. **Ledger core.** All financial activity is recorded as balanced double-entry transactions:
   - Account balances are derived from the entries, never typed in.
   - Categories are income or expense ledger accounts.
   - Hidden system equity accounts absorb opening balances, balance adjustments and investment valuation changes. That keeps those out of income and expense reports while keeping net worth correct.
2. **Planned and actual records are separate entities.** A recurring rule generates planned occurrences, and an occurrence becomes "completed" only by linking it 1:1 to an actual transaction. Planned items never touch balances, reports or net worth.
3. **Budgeting.** The MVP uses traditional monthly category budgets, plus virtual goal allocations, plus an informational "monthly plan" summary. Zero-based or envelope budgeting is designed to be compatible but deferred as an optional mode. Rollover is deferred. (Decision B-1.)
4. **Safe to Spend** (conservative default, "until next payday"):
   `STS = Eligible Liquid Funds − Unfunded Committed Obligations − Protected Reserve − Unavailable Goal Allocations`
   - The window runs until the next *payday* (the next income marked as payday), not including payday itself, with a 30-day fallback. On payday, items due that day count until the salary is recorded (I-2, option c).
   - Expected income is never added.
   - Credit card balances are reserved by default.
   - Each term draws from a different set of money and obligations, so nothing is subtracted twice. (Decision S-1.)
5. **Savings goals.** There are two funding methods, and they're mutually exclusive per account:
   - A *dedicated account*: the whole account balance counts toward the goal, and the account becomes non-spendable.
   - *Virtual allocations*: a portion of a non-dedicated cash account is earmarked.

   Goal progress is always the **backed** amount, never more than the real money behind it. That prevents double counting even when balances fall.
6. **MVP:**
   - Authentication and isolation.
   - Accounts, including credit cards and loans as liabilities.
   - Transactions: income, expense, transfer, refund, split, adjustment.
   - Categories, payees and tags.
   - Monthly budgets.
   - Recurring rules and the upcoming-payments list.
   - Goals.
   - Safe to Spend.
   - Dashboard and core reports.
   - CSV import with deduplication and undo.
   - CSV export.
   - Reconciliation.
   - Audit trail and trash.
   - Responsive UI in 7 languages, each switched on when ready (MKT-1, MKT-2).

   **Excluded from the MVP:** more than one currency within a workspace, any BGN support (CUR-1), household sharing, billing, zero-based mode, rollover, amortization schedules, card statement cycles, Excel and PDF export, email notifications (other than security emails), and bank APIs.
7. **Highest-risk areas:**
   - Planned↔actual matching during import.
   - Safe to Spend edge cases.
   - Allocation shortfalls.
   - Edit and reversal integrity.
   - Cross-user isolation.

---

## 2. Confirmed decisions, assumptions and canonical definitions

### 2.1 Confirmed decisions (from your brief; not reopened)

| ID | Decision |
|---|---|
| C-1 | Multi-user from the first version, with strict per-user isolation. Architecture ready for future shared workspaces. Household features are not in the MVP. |
| C-2 | **Amended by CUR-1 (user decision, 2 Nov 2026):** the supported currencies are **EUR and USD only**. Each workspace has exactly one currency, chosen at signup, and every account, transaction and report in it uses that currency. USD is available in the MVP. There's no BGN support of any kind, including historical import. More than one currency within a workspace is Later, and the data model must allow it without a redesign (FR-23). |
| C-3 | Savings goals support both account-linked goals and virtual allocations, with no double counting. |
| C-4 | The budgeting philosophy is open. Both models must be compared (§4). |
| C-5 | Safe to Spend is a dedicated indicator with a documented formula, never the plain sum of balances. The formula is open (§7). |
| C-6 | Staged development with deliverables, acceptance criteria and an approval gate per stage. |
| C-7 | **Amended by MKT-1 (user decision, 2 Nov 2026):** the product targets the **EU first**, not only Bulgaria. The UI supports **English, Bulgarian, German, Spanish, Italian, French and Greek**. **MKT-2:** Russian is dropped, and languages go live in phases: **English only at launch**, the others later (FR-22). The US market comes later. |
| C-8 | The product targets ordinary users with no accounting knowledge, and commercial readiness is a long-term goal. |
| C-9 | Bank API connectivity is not assumed and is out of the MVP. Manual entry and CSV import come first. **MKT-1:** automatic bank/card connection through a licensed open-banking provider (PSD2) is planned for **release 1.1**. The app never asks for card numbers or bank passwords. |

### 2.2 Working assumptions (reversible defaults; see the Open Decisions Register in §14)

| ID | Assumption | Why this default |
|---|---|---|
| A-1 | Each workspace has a timezone, defaulting to the one detected from the browser at sign-up and editable later (MKT-1). "Today" and month boundaries use the workspace timezone. Test fixtures use Europe/Sofia. | Month-boundary correctness |
| A-2 | Transaction dates are **calendar dates** with no time of day. Creation and edit timestamps are stored separately. | Avoids timezone shifts moving transactions between months |
| A-3 | The week starts on Monday and the budget period is the calendar month. | European convention, simplest model |
| A-4 | Categories have two levels (category › subcategory). | Enough for personal finance, and keeps reports readable |
| A-5 | Each user has one personal workspace in the MVP. | C-1 plus future household support |
| A-6 | Authentication uses email and password, with TOTP two-factor as a Should Have. No social login in the MVP. | Lowest dependency, GDPR-simple |
| A-7 | Recurring rules never post actual transactions automatically in the MVP. The user confirms each one, or it's matched to an import. | Protects the planned/actual separation |
| A-8 | Actual transactions cannot be dated in the future. Future items must be scheduled as planned occurrences. | Keeps "actual" meaning actual |
| A-9 | A credit card is a liability account. There are no statement cycles in the MVP. | Correct accounting with minimal complexity |
| A-10 | Investments are tracked by manual valuation only. No holdings, prices or cost basis. | Avoids an entire sub-product |

### 2.3 Canonical definitions (binding for all sections)

**Ledger model**

- **Ledger accounts** are every place money can be posted:
  - *User accounts*: asset or liability, for example current account, card or loan.
  - *Categories*: income or expense.
  - *System accounts*: hidden.
- **System accounts:**
  - Opening Balance Equity (OBE).
  - Balance Adjustments (ADJ, equity).
  - Valuation Changes (VAL, equity).
  - Transfers in Transit (TIT, an asset clearing account; Should Have).
  - Conversion Rounding (CNV, equity; reserved for future multi-currency work. It receives no postings in the MVP).
- A **transaction** is an atomic set of ≥2 **postings** (lines). Each posting has a ledger account, an amount in integer euro cents, and a sign.
- **Balancing invariant:** within each transaction, the postings sum to exactly 0 (per currency). A transaction is either fully posted or not posted at all.
- **Sign convention** (internal only, never shown to users): positive = debit, negative = credit.
  - Asset accounts and expense categories increase with positive postings.
  - Liability accounts, income categories and equity accounts increase with negative postings.
- **Displayed values:**

| Ledger account kind | Displayed as |
|---|---|
| Asset | Σ postings |
| Liability ("amount owed") | −Σ postings |
| Income category | −Σ postings |
| Expense category | Σ postings |

**Transaction status**

- An **actual** transaction is a posted, non-voided transaction.
- Only actual transactions affect any balance or report.
- Voided and deleted (trashed) transactions are excluded everywhere except the audit trail and trash.
- **Planned occurrences** are not transactions. They have no postings.

**Account classes**

| Class | User account types | Default "spendable" |
|---|---|---|
| Cash | Current/checking, Savings, Cash wallet | Current = yes, Cash = yes, Savings = no |
| Investment | Investment (manual valuation) | No (cannot be enabled) |
| Other asset | Money lent to others, deposits, other | No (cannot be enabled) |
| Liability | Credit card, Loan, Other liability (including money borrowed from people) | Not applicable |

- Spendable can be toggled only on Cash-class accounts.
- An account dedicated to a goal is always non-spendable.

**Metrics**, for any date *d* and period *P = [p₁, p₂]*. All are computed from actual transactions only.

| Metric | Definition |
|---|---|
| Bal(a, d) | Σ postings to account *a* with transaction date ≤ *d* |
| **Cash Balance(d)** | Σ Bal(a, d) over all Cash-class accounts. This is the brief's "total available funds"; I'm renaming it to avoid confusion with Safe to Spend. |
| **Assets(d)** | Σ Bal(a, d) over all asset-class user accounts plus TIT. An overdrawn current account is a negative asset. It is not reclassified as a liability, and net worth is unaffected either way. |
| **Liabilities(d)** | −Σ Bal(a, d) over all liability accounts. An overpaid card reduces Liabilities. |
| **Net Worth(d)** | Assets(d) − Liabilities(d) |
| **Income(P)** | −Σ postings to income categories, dated in P |
| **Expenses(P)** | Σ postings to expense categories, dated in P. Refunds are negative expense postings, so they reduce this figure. |
| **Net Result(P)** | Income(P) − Expenses(P). This is what the brief calls "net cash flow"; see the note after this table. |
| **Cash Change(P)** | Cash Balance(p₂) − Cash Balance(p₁ − 1 day) − (opening-balance postings to Cash accounts dated in P) |
| **Budget Spent(c, M)** | Σ expense postings in category *c* and its subcategories, dated in month M (net of refunds) |
| **Net Worth Change identity** | NW(p₂) − NW(p₁−1) = Net Result(P) + ADJ effect(P) + VAL effect(P) + OBE effect(P) + CNV effect(P). This is checked automatically as an integrity test. (CNV added by AP-14.) |

**Why "net cash flow" is split into two metrics.** It's ambiguous. On an accrual basis, income − expenses counts a card purchase immediately. On a cash basis, the cash change counts it only when the card is repaid. The two differ whenever cards, loans, investments or savings transfers are involved. **Approved (D-2, I-11):** the dashboard shows **Net Result** labelled "Income − Expenses" ("Приходи − Разходи"); reports show **Cash Change** labelled "Change in cash" ("Промяна в наличностите"). The term "net cash flow" isn't used anywhere in the UI.

**Safe to Spend (canonical form; full specification in §7)**

```
STS(today) = ELF − UCO − PR − UGA
ELF = Σ Bal(a, today) over spendable accounts (negative balances included)
UCO = Σ unmatched planned outflows from spendable accounts due in the window W
      + Σ all overdue unmatched planned outflows from spendable accounts
      + Σ max(0, amount owed) on credit cards with "reserve balance" = on (default on)
      + Σ unmatched planned expenses charged to reserved cards, due in W
      − excluded: transfers between spendable accounts; scheduled payments to reserved cards
      − R5: a planned payment linked to a goal counts only max(0, amount − remaining backed goal money)
PR  = Protected reserve (user-set amount, default €0)
UGA = Σ over spendable accounts a of Allocated(a)
      + Σ over non-spendable Cash accounts a of max(0, Allocated(a) − max(0, Bal(a, today)))   (AM-1)
H   = due date of the earliest Planned "payday" income occurrence with due date ≥ today, capped at today + 45 days;
      if none, H = today + 30 days. Overdue payday income is ignored.
W   = [today, H) when H comes from a payday (payday excluded);
      [today, today] when H = today and that payday is still unmatched (items due today count);
      [today, today + 30] in the fallback case.
```

---

## 3. Product Requirements Document

### 3.1 Purpose

The product gives non-experts a trustworthy, low-effort view of their money, and in particular a defensible answer to "how much can I safely spend right now". Correctness of numbers takes priority over breadth of features.

### 3.2 Target users (personas; the target audience is still open, see Decision D-7)

| Persona | Profile | Primary need |
|---|---|---|
| P1 "Salaried planner" | Monthly salary, rent or mortgage, a card, wants control | Safe to Spend, budgets, upcoming bills |
| P2 "Debt reducer" | Consumer loan or card debt | Seeing debt fall, splitting interest from principal |
| P3 "Saver" | Saving for a home or car | Goals that don't double-count money |
| P4 "Irregular earner" | Freelancer, variable income | Conservative Safe to Spend, cash runway |
| P5 (future) "Household" | A couple with shared costs | Shared workspace (Later) |

### 3.3 Primary use cases

1. Set up accounts with opening balances in under 10 minutes.
2. Record a purchase in 3 or fewer interactions after opening quick-add.
3. Import last month's bank CSV, review it, and confirm.
4. See today's Safe to Spend and the reason for the number.
5. Set monthly category limits and see progress against them.
6. See upcoming bills and mark them as paid or matched.
7. Track goals and debts.
8. Compare this month with last month.
9. Reconcile against a bank statement.
10. Export all data.

### 3.4 Functional requirements

Notation: **BR** = business rule, **AC** = acceptance criterion. Priority uses MoSCoW: Must, Should, Could, Later.

---

#### FR-01 · Registration, login and account security: **Must**

**Purpose:** secure, low-friction access.

**User stories:**
- As a new user, I register with my email and password and verify my email.
- As a user, I reset a forgotten password.
- As a user, I sign out of all devices.
- As a user, I enable two-factor authentication (Should).

**Behavior and rules:**
- BR-01.1: Email verification is required before the workspace can be accessed.
- BR-01.2: Passwords are at least 12 characters and checked against a list of known-breached passwords. No composition rules (NIST SP 800-63B style).
- BR-01.3: Failed logins are throttled per account and per source. From the 5th failure within 15 minutes, progressive delays apply.
- BR-01.4: Password-reset tokens are single-use and expire after 60 minutes. Responses never reveal whether an email address is registered.
- BR-01.5: Sessions have an idle timeout and an absolute lifetime (values in §11).
  - Changing the password invalidates all other sessions.
  - Sensitive actions require re-authentication within the last 10 minutes: export, account deletion, email or password change, disabling 2FA.
- BR-01.6: Security emails (verification, reset, email change, new-device sign-in) are Must, even though other email notifications are Later.

**Dependencies:** an email delivery service (choice made in Stage 2).

**Edge cases:**
- Registering with an existing email gives the generic "check your inbox" response.
- An email change requires confirmation from the new address and a notice to the old one.
- An email address from a deleted account can be reused only after the deletion completes.

**Acceptance criteria:**
- AC-01.1: An unverified account cannot read or write any financial data.
- AC-01.2: Registering or resetting with an existing vs a non-existing email returns identical response content.
- AC-01.3: A reset link fails after 60 minutes and after its first use.
- AC-01.4: After a password change, every other session is rejected on its next request.
- AC-01.5: Sustained failed logins are throttled as specified (automated test).
- AC-01.6: Export and account deletion require recent re-authentication.

---

#### FR-02 · Independent workspaces and data isolation: **Must**

**Purpose:** guarantee that no user can see or affect another user's data.

**User story:** as a user, I'm certain that my data is visible only to me.

**Behavior and rules:**
- BR-02.1: Registration creates exactly one Personal workspace, with the user as its Owner.
- BR-02.2: Every financial record belongs to exactly one workspace. Data is never owned directly by a user. This is what makes future households possible.
- BR-02.3: Every read and write is authorized by workspace membership. Cross-workspace references are rejected: a transaction can't use a category, account or payee from another workspace.
- BR-02.4: Isolation is enforced by two independent layers, application authorization and database-level restriction. The mechanisms are chosen in Stage 2.
- BR-02.5: Record identifiers are non-sequential and unguessable. Access to another workspace's record returns "not found", not "forbidden", so existence isn't revealed.
- BR-02.6: Aggregates, search, exports, notifications and background jobs are scoped to the workspace.

**Edge cases:**
- Background jobs (recurring generation, notifications) must run per workspace.
- Logs and error messages must never contain another user's data.
- Shared caches must include the workspace in every key.

**Acceptance criteria:**
- AC-02.1: For every data endpoint or operation, an automated test confirms that user B receives "not found" when using user A's identifiers, for read, update, delete and reference-in-create.
- AC-02.2: Disabling the application authorization layer in a test environment still prevents cross-workspace reads, proving the second layer works.
- AC-02.3: An export by user B contains zero records from user A (golden scenario on isolation).
- AC-02.4: Dashboard totals for user B are unchanged when user A adds transactions.

---

#### FR-03 · Financial accounts, opening balances and account types: **Must** (Investment type: **Should**)

**Purpose:** model where the user's money and debts are.

**User stories:**
- As a user, I add my current account with its balance today.
- I add my credit card with the amount I owe.
- I mark my savings account as not spendable.

**Behavior and rules:**
- BR-03.1: Each account has a name, type (§2.3), class (derived), currency (EUR in the MVP, but stored), opening date, opening balance, spendable flag, optional institution, optional credit limit (cards; informational), optional notes, display order and archived flag.
- BR-03.2: The opening balance is posted as an *Opening Balance* transaction against OBE, dated on the opening date. There is exactly one per account. It's editable, with the change audited.
- BR-03.3: For liabilities, the user enters the owed amount as a positive number, and the system posts it as a liability.
- BR-03.4: The current balance is always derived (§2.3). No editable balance field exists. Correcting a balance is done via reconciliation or adjustment (FR-18).
- BR-03.5: Transactions dated before the account's opening date are rejected. The user must move the opening date earlier, and opening-balance amounts are not recalculated automatically.
- BR-03.6: Account type can change only within the same class (for example current ↔ savings). Changing asset ↔ liability is blocked once transactions exist.
- BR-03.7: Spendable can be toggled only on Cash-class accounts that aren't dedicated to a goal.

**Dependencies:** FR-02 and the ledger core.

**Edge cases:**
- A negative opening balance on a current account (overdraft) is allowed.
- A €0 opening balance is allowed, and no transaction is created.
- Two accounts with the same name trigger a warning only.
- A card opened with a credit balance (overpaid) is entered as a negative owed amount, with confirmation.

**Acceptance criteria:**
- AC-03.1: Creating an account with an opening balance of €1,000 produces exactly one balanced transaction (account +100000 cents, OBE −100000), and the displayed balance is €1,000.
- AC-03.2: An opening balance changes Net Worth but changes neither Income nor Expenses for any period.
- AC-03.3: A card with €300 owed shows Liabilities +€300 and Net Worth −€300.
- AC-03.4: An attempt to post a transaction before the opening date is rejected with an explanatory message.
- AC-03.5: No user interface or import path can set a balance directly.

---

#### FR-04 · Income, expenses, transfers, refunds and adjustments: **Must**

**Purpose:** record every money movement with correct accounting.

**User stories:**
- I add an expense in a few taps.
- I record a transfer to savings.
- I record a refund against the original purchase.
- I fix a balance that's off.

**User-facing transaction kinds** (each maps to fixed posting patterns, defined in §5):

| Kind | Postings (summary) |
|---|---|
| Expense | Account credited, expense category debited |
| Income | Account debited, income category credited |
| Transfer | Source credited, destination debited. Neither is a category. |
| Refund | The reverse of an expense, in the original expense category. It can be linked to the original. |
| Debt payment | A template producing a transfer (principal) plus expense lines (interest, fees) |
| Balance adjustment | Account vs ADJ (or an expense or income category, if the user chooses; see §5) |
| Opening balance | System only (FR-03) |
| Valuation | Investment account vs VAL (FR-03, FR-10) |

**Behavior and rules:**
- BR-04.1: The amount entered is always positive. Direction comes from the kind. Zero-amount transactions are rejected.
- BR-04.2: The date is required, must not be in the future (A-8), and must not be before the account's opening date.
- BR-04.3: Each transaction stores:
  - Created and updated timestamps.
  - Source: manual, import, from-occurrence or system.
  - Optional payee, memo and tags.
  - Optional links: refund → original transaction, transaction → planned occurrence, transaction → import row.
- BR-04.4: Duplicate (copy) creates a new transaction dated today, with no links copied.
- BR-04.5: Search and filter cover date range, account, category (with subtree), payee, tag, amount range, text, kind, source and reconciliation state.
- BR-04.6: Editing a transaction replaces its postings atomically and records a version in the audit history (FR-19). Reconciled transactions are locked (FR-18).
- BR-04.7: A refund's amount can exceed the linked original only after explicit confirmation. The category may then show negative spending for the period.
- BR-04.8 (B-2, I-9): A refund is dated on the day it arrives and counts in that month. It's never back-dated to the original purchase (SC-6).
- BR-04.9 (D-17, I-8, SC-4): Cashback and card rewards, whether paid as cash or as a statement credit, are income in the seeded category "Cashback & rewards" by default. The user may instead record them in an expense category as a negative expense, like a refund (GT-63).

**Edge cases:**
- A transfer where source and destination are the same account is rejected.
- A transfer from a cash account into a liability (a debt repayment) is valid.
- An expense paid partly in cash and partly by card is recorded as two transactions.
- An income reversal (for example an employer recalls an overpayment) is a negative income line, done as a "Refund" of an income transaction.

**Acceptance criteria:**
- AC-04.1: Every saved transaction's postings sum to 0 (checked by the integrity job and by tests).
- AC-04.2: A €200 transfer between two accounts changes neither Income nor Expenses for any period, and leaves Net Worth unchanged.
- AC-04.3: A €30 refund linked to a €100 Food expense yields Food spending of €70 for a single-month period.
- AC-04.4: A future-dated actual transaction is rejected, and the user is offered "schedule instead".
- AC-04.5: The search results' total equals the sum of the displayed lines.

---

#### FR-05 · Categories, subcategories, payees and tags: **Must** (tags: **Should**)

**Purpose:** classification that drives reports and budgets.

**Behavior and rules:**
- BR-05.1: There are two levels. Each category is of type Income or Expense, and the type is immutable once the category is used.
- BR-05.2: Default sets are seeded in the user's language on workspace creation (the brief's lists, plus "Interest and fees" and "Bank fees" under expenses). Users can rename, reorder, add, archive and merge them.
- BR-05.3: Postings are allowed to a parent or to a subcategory. A parent's totals equal its own postings plus all of its children's.
- BR-05.4: Deleting a category is allowed only if it's unused. Otherwise the user must merge it into another category of the same type, which reassigns history (audited), or archive it.
- BR-05.5: Moving a subcategory to another parent changes historical roll-ups. This is accepted and documented, and the user sees a warning.
- BR-05.6: Payees are created from entry or import. Each payee can have a default category (explicitly set, or learned from the last use). Payees can be merged. Import maps raw descriptions to payees through user-editable rules.
- BR-05.7: Tags are free labels, with many per transaction. They're for analysis only and never affect accounting.

**Edge cases:**
- Merging income into expense is blocked.
- Archiving a category with an active budget ends the budget from the next month and keeps the current month.
- A transaction with no category: imports may stage uncategorized rows, but confirmation requires a category or the transaction is saved to the system "Uncategorized" expense or income category, which is visible in reports.

**Acceptance criteria:**
- AC-05.1: Merging category X into Y moves all of X's postings to Y, and the totals for Y afterwards equal X + Y before.
- AC-05.2: A parent category's report total equals the sum of its own and its children's lines.
- AC-05.3: The Uncategorized total is displayed whenever it's non-zero.

---

#### FR-06 · Split transactions: **Must**

**Purpose:** one real payment, several categories (or a category plus a transfer component).

**Behavior and rules:**
- BR-06.1: A transaction can contain multiple category lines. Lines can also include account lines (for example a principal component). All postings must balance.
- BR-06.2: The user enters a total and line amounts. The transaction can't be saved while the "unassigned remainder" is non-zero.
- BR-06.3: A percentage split computes cents with the largest-remainder method so that the lines sum exactly to the total (§10).
- BR-06.4: Each line can have a memo. Tags apply to the whole transaction in the MVP.
- BR-06.5: Reports and budgets use line amounts, never the transaction total.
- BR-06.6 (AM-5): A split that can't give every line a non-zero amount is rejected. For example, €0.01 can't be split into two lines (LR-02).

**Edge cases:**
- Mixed income and expense lines in one transaction (for example a salary with a deduction) are allowed, and each line counts in its own type.
- A split with a single line collapses into a normal transaction.
- A negative line inside an expense split (a discount line) is allowed if the transaction still balances.

**Acceptance criteria:**
- AC-06.1: Saving fails if the lines differ from the total by even €0.01.
- AC-06.2: A 3-way equal split of €100.00 yields €33.34, €33.33 and €33.33, totalling €100.00.
- AC-06.3: Category report totals include split lines in their respective categories.

---

#### FR-07 · Monthly budgets and spending limits: **Must**

This assumes the traditional model; see §4 and Decision B-1.

**Purpose:** set limits per category and see progress and warnings against them.

**Behavior and rules:**
- BR-07.1: A budget is (expense category, calendar month, limit amount). Budgets can repeat monthly by default, through a template copied forward. A change applies to the selected month and, optionally, all later months.
- BR-07.2: Within one category branch, budgets exist at either the parent level or the subcategory level, never both. This prevents overlapping totals.
- BR-07.3: An optional **overall monthly limit** covers all expenses. If the sum of category budgets exceeds it, the user sees a warning but isn't blocked.
- BR-07.4: **Spent** follows §2.3. It includes credit card purchases on their purchase date and refunds on their refund date. It excludes transfers, loan principal and planned items.
- BR-07.5: **Scheduled** = unmatched planned occurrences in that category due later in the month. It's shown separately and never added to Spent.
- BR-07.6: Remaining = Limit − Spent. It can be negative, shown as overspent.
- BR-07.7: Warning thresholds are configurable per budget (up to 3; default 80% and 100%). The comparison uses exact integer arithmetic: Spent × 100 ≥ Limit × threshold.
- BR-07.8: Rollover is not in the MVP (Could, Later). Each month starts fresh.
- BR-07.9: An unused budget is never income, never cash, and never part of Safe to Spend.
- BR-07.10 (Should): The **monthly plan** summary is expected income (from payday and estimated recurring income for the month) − Σ budgets − planned goal contributions − planned debt principal = unplanned amount. It's informational only.
- BR-07.11 (AM-3): Budget utilization is **displayed truncated to one decimal place**, never rounded up, so the display never shows "80.0 %" before the 80 % alert has fired (GT-57).
- BR-07.12 (I-9): Refunds count in the month they arrive. Closed months never change.
- BR-07.13 (I-6): A card instalment purchase counts in full in the purchase month. The overspent budget shows a one-line note, for example "includes instalment purchase TV €600".

**Edge cases:**
- Refunds exceeding purchases make Spent negative, shown as 0% utilization with a "net refund" label.
- A limit changed mid-month applies to the whole month.
- An archived category with history keeps its past budgets.
- A €0 budget means any spending is 100%+ utilization; division by zero is avoided by treating utilization as "over" when Spent > 0.

**Acceptance criteria:**
- AC-07.1: With a Food budget of €250, transactions of €100 and €60 (one on a card) give Spent €160, Remaining €90, utilization 64%.
- AC-07.2: Crossing 80% triggers exactly one threshold event for that budget and month, even if more transactions follow.
- AC-07.3: A refund of €20 in the same month reduces Spent by €20, and the threshold state is recomputed (no new event is raised for going back down).
- AC-07.4: A transfer to savings never appears in any budget's Spent.
- AC-07.5: Budget totals for a month reconcile with the category report for the same month.

---

#### FR-08 · Recurring rules and planned occurrences: **Must**

**Purpose:** know what's coming, and turn plans into actuals without duplicates.

**Behavior and rules:**
- BR-08.1: A **rule** stores:
  - A template: kind, amount, account(s), category or split, payee.
  - Frequency: weekly, every N weeks, monthly on day D, monthly on the last day, every N months, yearly.
  - A start date, plus an optional end date or count.
  - An amount type: *fixed* or *estimated*.
  - A **payday** marker (income only, used by Safe to Spend), with a required payer and an optional expected amount range (SC-2, §7.6).
  - A non-working-day setting: on the date (default), previous working day, or next working day (SC-1, Should).
  - A reminder lead time in days.
- BR-08.2: **Occurrences** are generated idempotently for a rolling 13-month window. The key (rule, original scheduled date) is unique, so regeneration never duplicates.
- BR-08.3: Occurrence statuses are *Planned*, *Completed* (linked to exactly one actual transaction), *Skipped* and *Cancelled* (rule ended or deleted). **Overdue** is derived: Planned with due date < today.
- BR-08.4: An actual transaction can be linked to at most one occurrence, and an occurrence to at most one transaction. (Partial payments are Later.)
- BR-08.5: Ways to complete an occurrence:
  - *Confirm*: creates an actual transaction from the template; the user can change the amount and date.
  - *Match*: links an existing or imported transaction.
  - *Skip*.
- BR-08.6: Editing a rule regenerates only future Planned occurrences that haven't been individually edited. Completed, skipped and individually edited occurrences are preserved.
- BR-08.7: Day 29, 30 or 31 in shorter months falls on the last day of the month. The non-working-day setting then shifts the **due date** for weekends (SC-1); the occurrence key keeps the original date. Public holidays are Later and will be per country (OD-09).
- BR-08.8: Unlinking a completed occurrence returns it to Planned (or Overdue). The actual transaction remains.
- BR-08.9: Planned occurrences never affect balances, Income, Expenses, Net Worth or budget Spent.
- BR-08.10 (I-4): Matching suggestions apply to manual entries as well as imports and confirmations. The matching rules M-1 to M-8 are in §9.5.

**Edge cases:**
- A rule with a start date in the past creates occurrences from the start date, and past ones appear as Overdue. On creation the user is asked to mark them as already paid or to skip them.
- A rule whose amount changes (a rent increase) is handled by editing it from a date onward.
- A matched transaction's amount differs from the occurrence's (an electricity estimate of €60 vs an actual €71.40). The occurrence completes with the actual amount, and no remainder stays planned.

**Acceptance criteria:**
- AC-08.1: Running generation twice produces no duplicate occurrences.
- AC-08.2: A monthly rule on day 31 generates 28 or 29 February, 30 April, and so on.
- AC-08.3: After a Rent occurrence is matched to an imported transaction, Upcoming no longer lists it, Safe to Spend no longer reserves it, and the balance reflects exactly one rent payment.
- AC-08.4: An attempt to link a second transaction to a completed occurrence is rejected.

---

#### FR-09 · Savings goals and virtual allocations: **Must** (projections: **Should**)

**Purpose:** track progress toward goals without inventing money. The full rules are in §8.

**Behavior and rules (summary):**
- BR-09.1: A goal has a name, an optional target amount, an optional target date, an optional planned monthly contribution, and a funding method. The method is either *dedicated account(s)* or *virtual allocations*, never both.
- BR-09.2: For a dedicated account goal, progress = max(0, Σ balances of the linked accounts).
  - Each account can be dedicated to at most one goal.
  - A dedicated account becomes non-spendable and can't hold virtual allocations.
- BR-09.3: Virtual allocations are earmarks on non-dedicated Cash accounts.
  - When creating or increasing an allocation, Σ allocations on an account must be ≤ max(0, balance).
  - Progress = **backed** amount (§8).
- BR-09.4: Goals never change balances, Income, Expenses or Net Worth.
- BR-09.5 (AP-03): A planned payment can be linked to one goal (rule R5, Must), shown as "Save for a bill" (SC-3).
- BR-09.6 (AP-01): Expenses on an account with allocations trigger the "Is this paid from your goal money?" prompt (G-P4).

**Acceptance criteria (summary; full list in §8):**
- AC-09.1: Allocating €2,000 of a €3,000 account leaves Net Worth and Cash Balance unchanged and reduces Safe to Spend by €2,000 (if the account is spendable).
- AC-09.2: An allocation exceeding the unallocated balance is rejected.
- AC-09.3: If the balance falls below allocations, goal progress shows the backed amount and a shortfall warning.

---

#### FR-10 · Credit cards and debts: **Must** for the core / **Later** for statement cycles and amortization

**Purpose:** correct liabilities, with no double-counted expenses.

**Behavior and rules:**
- BR-10.1: A credit card purchase is an expense on the purchase date, and increases the card liability.
- BR-10.2: A card repayment is a transfer: cash account → card. It is never an expense.
- BR-10.3: Card interest, annual fees and cash-advance fees are expenses, and increase the liability.
- BR-10.4: A card refund reduces the card liability and the original expense category.
- BR-10.5: A loan is a liability account with an opening owed amount. Optional information fields: original principal, interest rate, installment, term.
- BR-10.6: A **debt payment** splits into:
  - A principal transfer, which reduces the liability.
  - Interest, an expense in "Interest and fees".
  - Fees, also an expense.

  The user enters the split, or a recurring rule's default split is pre-filled and must be confirmed. The MVP doesn't compute amortization (Later).
- BR-10.7: Borrowing (a loan disbursement, or money received from a person) is a transfer from the liability into the cash account. It is never income.
- BR-10.8: The "Reserve balance in Safe to Spend" flag per card defaults to on (§7).
- BR-10.9: Statement cycles, minimum payments and card instalment plans are Later. For instalment purchases, the full price is an expense at purchase (D-15, I-6); see §5.
- BR-10.10 (D-16, I-7): A purchase financed by a loan is an expense by default. A "Track as an asset" option appears for purchases of €5,000 or more, or in the categories Vehicle and Property.
- BR-10.11 (AM-4): A loan taken out *while the user is already tracking* is created as an account with €0 owed, followed by a disbursement **transfer**. The opening-balance method is only for debts that existed before tracking started (GT-19).
- BR-10.12 (I-10): An overdrawn current account stays a negative asset. A separate overdraft credit line can be set up by the user as a liability account.

**Debt overview:** total liabilities, a breakdown by account, the change in each liability over the selected period, upcoming debt payments, and interest paid in the period.

**Edge cases:**
- An overpaid card gives a negative owed amount, which reduces Liabilities.
- A loan paid off reaches €0, and the user is offered archiving.
- The bank's reported remaining principal differs from the ledger. This is resolved by reconciliation, where the adjustment is classified as interest/fees or as an adjustment.

**Acceptance criteria:**
- AC-10.1: A €50 card purchase followed by a €50 repayment gives Expenses €50 (not €100), card owed €0, and Cash Balance −€50.
- AC-10.2: A €400 instalment split €320/€80 gives Expenses €80, a liability reduced by €320, Cash Balance −€400 and Net Worth −€80.
- AC-10.3: Receiving a €1,000 loan gives Income €0 and Net Worth unchanged.

---

#### FR-11 · Financial calendar and upcoming obligations: **Must** for the list / **Should** for the month grid

**Purpose:** show what's due and what's overdue.

**Behavior:**
- An "Upcoming" list shows overdue items first, then the next 30 days, with each item's amount, account, status and actions (confirm, match, skip).
- The calendar grid shows planned (hollow) and actual (solid) items per day, with daily in and out totals.
- Reminder lead days drive notifications (FR-20).

**Edge cases:** many occurrences on one day; overdue items older than 90 days are collapsed into a group.

**Acceptance criteria:**
- AC-11.1: Overdue items are always visible regardless of filter, until completed or skipped.
- AC-11.2: Every item on the calendar is either an occurrence or an actual transaction, never both for the same event (a completed occurrence displays as its actual).

---

#### FR-12 · Safe to Spend: **Must**

The full specification is in §7.

**Acceptance criteria (summary):**
- AC-12.1: The displayed value equals the canonical formula (§2.3) for every golden scenario.
- AC-12.2: Tapping the value shows each term, with the contributing accounts, obligations and allocations listed and summing to the term.
- AC-12.3: A negative value is shown as a shortfall, not clamped to zero.
- AC-12.4: The value never equals Cash Balance unless every term other than ELF is zero and every Cash account is spendable. A test asserts that the terms are computed independently.

---

#### FR-13 · Short-term cash-flow projection: **Should**

**Purpose:** "Will I run short before payday?"

**Behavior:**
- A daily projected balance for the spendable accounts over 30, 60 or 90 days.
- The start is today's ELF. Unmatched planned outflows are subtracted on their due dates, and overdue outflows on day 0.
- Two lines are shown: **commitments only** (no income), and **with expected income** (payday plus estimated income, on their due dates).
- The lowest point and its date are highlighted. If the commitments-only line goes below 0 or below PR, the user gets a warning.

**Rule (amended by I-12 / ER-4):** card purchases don't reduce the projection directly. For a reserved card with a scheduled repayment, the projection subtracts the repayment on its date, and an information line explains "Card €60 reserved now, paid on 5 Nov". For a reserved card with **no** scheduled repayment, the projection subtracts the card balance on day 0. This keeps the projection consistent with Safe to Spend (GT-69).

**Acceptance criteria:**
- AC-13.1: The brief's example: €1,200 balance, €1,500 expected income and €900 planned expenses give an end-of-horizon projection of €1,800 on the "with income" line and €300 on the "commitments only" line.

---

#### FR-14 · Dashboard and financial overview: **Must**

**Widgets:**
- Safe to Spend (primary).
- Cash Balance.
- Net Worth (with Assets and Liabilities).
- Income, Expenses and Net Result for the selected period.
- Spending by category.
- Budget status.
- Upcoming and overdue items.
- Goal progress.
- Recent transactions.
- A 12-month income/expense trend.

**Rules:**
- The period selector offers current month, previous month, current year, previous year and a custom range.
- Point-in-time widgets (balances, Net Worth) show values *as of the period end*, or today if the period includes today, and say which.
- Safe to Spend and Upcoming are always as of today, whatever the period.
- Every number comes from the canonical metric definitions (§2.3) and has a drill-down.

**Acceptance criteria:**
- AC-14.1: For every widget, the drill-down list sums to the displayed number.
- AC-14.2: The dashboard's Expenses for a period equals the total of the category report for the same period.
- AC-14.3: Load time: p95 < 1.5 s for a workspace with 50,000 transactions.

---

#### FR-15 · Reports and period comparisons: **Must** for the core set / **Should** for the rest

| Report | Priority |
|---|---|
| Income and expenses by month (up to 24 months) | Must |
| Spending by category and subcategory, with drill-down to transactions | Must |
| Period comparison (A vs B: absolute and % change for income, expenses, net result and each category) | Must |
| Budget vs actual (month) | Must |
| Net worth over time (month-end) | Must |
| Largest transactions | Should |
| Average monthly expenses (total ÷ number of full months in the range; a partial current month is excluded unless chosen) | Should |
| Cash Change by account | Should |
| Savings rate = Net Result ÷ Income | Should |
| Interest paid by debt | Should |
| Excel and PDF export | Later |
| CSV export of any report | Should |

**Rules:**
- All reports use §2.3 definitions.
- When comparing periods, a % change with a zero base is shown as "new" rather than as ∞.

**Acceptance criteria:**
- AC-15.1: The category report total equals Expenses(P).
- AC-15.2: Net worth over time satisfies the Net Worth Change identity for every month.
- AC-15.3: The September vs October comparison matches golden scenario values.

---

#### FR-16 · CSV import, duplicate detection and import reversal: **Must** (Excel files: **Should**)

**Purpose:** cut manual entry to a review step. The full lifecycle rules are in §9.

**Steps:**
1. Upload.
2. Detect the file format: encoding (UTF-8; Windows-1252 and ISO-8859-1/-15 for Western European banks; Windows-1251 for Cyrillic, common in Bulgarian exports; Windows-1253 and ISO-8859-7 for Greek), delimiter, decimal separator, date format and header row.
3. Map the columns:
   - Date: transaction date, plus value date if present.
   - Amount, as a single signed column or separate debit and credit columns.
   - Description, counterparty, reference.
   - Running balance (optional).
4. Choose the target account.
5. Save the mapping as a profile.
6. Preview.
7. Classify each row: new, exact duplicate, or possible duplicate.
8. Suggestions: payee and category (rules), transfer pairing, and recurring matches.
9. Review and edit.
10. Confirm, which creates an **import batch**.

**Rules:**
- BR-16.1: Imported rows become actual transactions only on confirmation.
- BR-16.2: Identical rows within one file are all imported. Each gets an ordinal in its duplicate fingerprint (§9).
- BR-16.3: Exact duplicates of previously imported rows are skipped by default but visible, and the user can override.
- BR-16.4: Possible duplicates (matching a manual entry by account, amount and date ±3 days) require a decision: merge (link) or keep both.
- BR-16.5: An inflow matched to an outflow in another of the user's accounts (same amount, date ±3 days) is suggested as **one transfer**, never as income plus expense.
- BR-16.6: The **undo import** action voids every transaction in the batch and returns matched occurrences to Planned.
  - It's blocked for transactions that have since been reconciled, until those are unlocked.
  - Transactions edited after import are listed for confirmation.
- BR-16.7: The raw file is discarded after parsing. Parsed rows are kept for audit and undo.
- BR-16.8: Limits are 5 MB and 10,000 rows per file. The running-balance column, if present, is used to validate the parse (Should).
- BR-16.9 (I-4, ER-3): One-to-one claiming. Each existing transaction can be claimed by at most one import row. Rows with no unclaimed candidate are treated as new (§9.5, M-6).
- BR-16.10: Planned-occurrence matching during import follows §9.5 (M-1 to M-5), including the weekly window W = min(5, floor((P − 1) / 2)) days (ER-2).

**Acceptance criteria:**
- AC-16.1: Importing the same file twice creates zero new transactions the second time.
- AC-16.2: A file with two identical €2.50 rows on the same date creates two transactions.
- AC-16.3: An import containing a rent payment matching a planned occurrence results in one rent expense and a completed occurrence.
- AC-16.4: Undoing an import restores all balances, reports and occurrences to their pre-import values.
- AC-16.5: A Windows-1251 file with comma decimals parses Cyrillic text and amounts correctly.

---

#### FR-17 · CSV export and data portability: **Must**

**Behavior:**
- Export transactions (one row per line), accounts, categories, payees, tags, budgets, goals, allocations, recurring rules and occurrences, as CSV files in a ZIP archive.
- A full "export my data" package in machine-readable form (CSV plus JSON).
- Files are UTF-8 with a BOM, for Excel compatibility.
- Formula injection is neutralized: cells starting with `=`, `+`, `-` or `@` are escaped, and a numeric-only column is exempt.

**Acceptance criteria:**
- AC-17.1: The exported transaction lines sum to 0 per transaction.
- AC-17.2: The exported balances match the app.
- AC-17.3: A description starting with "=" is exported as inert text.
- AC-17.4 (Should): Re-importing a full export into an empty workspace reproduces identical balances.

---

#### FR-18 · Balance reconciliation: **Must**

**Behavior:**
- The user picks an account, a statement date and a statement closing balance.
- The system shows the cleared balance (reconciled and checked items ≤ the statement date), the unreconciled items to tick, and the difference.
- When the difference is 0, the user finishes and the ticked items become **reconciled and locked**.
- If a difference remains, the user either fixes transactions or posts a **balance adjustment**, by default to ADJ (excluded from income and expenses). The user can choose an expense or income category instead, with an explanation.
- **Quick balance update** for cash wallets and investments: the user enters the actual value, and the system creates an adjustment (cash) or a valuation (investment).

**Rules:**
- Editing or deleting a reconciled transaction requires an explicit unlock with a warning.
- Unlocking flags the reconciliation as broken until it's redone.
- The reconciliation history is retained.

**Acceptance criteria:**
- AC-18.1: A statement of €1,243.17 against a ledger of €1,251.17 with no correction gives an adjustment of −€8.00 to ADJ: Income and Expenses unchanged, Net Worth −€8.00.
- AC-18.2: A reconciled transaction can't be changed without unlocking, and unlocking is audited.

---

#### FR-19 · Transaction history, undo, archiving and audit trail: **Must**

**Behavior:**
- **Undo:** the last create, edit or delete can be undone from an immediate toast.
- **Trash:** deleted transactions are recoverable for 30 days, then purged. The audit metadata (not the content) is kept.
- **Version history** per transaction: who changed it, when, and the before and after values.
- **Void:** a transaction is marked void and excluded from the ledger, but stays visible. This is used by import undo.
- **Archive account:** allowed only at a zero balance with no Planned occurrences. Otherwise the user is guided to reconcile or adjust, or to end the rules.
  - Archived accounts are hidden from pickers and remain in history and reports.
  - Unarchiving is allowed.
- **Archive category:** see FR-05.
- **Audit log** of security and financial events: login, failed login, 2FA change, export, import and undo, reconciliation, unlock, account and category merge or archive, account deletion request. A user-visible audit view is Should.

**Acceptance criteria:**
- AC-19.1: Deleting then restoring a transaction yields identical balances.
- AC-19.2: Editing an amount records a version entry with the old and new values.
- AC-19.3: An account with a non-zero balance can't be archived.

---

#### FR-20 · Notifications: **Should** for in-app / **Later** for email and push (security emails are Must, under FR-01)

**Types:**
- A budget threshold is crossed.
- A payment is due within its lead time.
- A payment is overdue.
- Safe to Spend turns negative.
- A goal is behind schedule (§8).
- An allocation is underfunded (§8).
- Payday income is overdue.
- Spending spikes (Later; this needs a statistical definition).

**Rules:**
- Each event is notified once per object and period, with no repeats.
- Users can set preferences per type.
- Notifications are created only from actual data, never from projections, except the explicitly forecast type (Later).

**Acceptance criteria:**
- AC-20.1: Crossing 80% twice in a month (after a refund then more spending) produces one notification.

---

#### FR-21 · Responsive mobile experience or PWA: **Must** for responsive / **Should** for installable PWA / **Later** for offline

**Behavior:**
- Fully usable from a 360 px width upward.
- Quick-add is reachable within 1 tap from any screen.
- Data tables collapse into card lists on small screens.
- No offline storage of financial data in the MVP, for privacy reasons.

**Acceptance criteria:**
- AC-21.1: Every Must Have flow can be completed on a 360×640 viewport (end-to-end tests).
- AC-21.2: There's no horizontal scrolling on any page at 360 px.

---

#### FR-22 · Localization: **Must** for English, Bulgarian, German, Spanish, Italian, French and Greek, switched on in phases (MKT-1, MKT-2)

**Behavior:**
- All user-visible strings are externalized, including emails, error messages, export headers and seeded category names.
- The language is chosen at sign-up (suggested from the browser) and can be changed at any time. English is the fallback for any missing string, and a missing string fails the build (AC-22.1).
- Numbers, dates and currency follow the user's locale, for example `1.234,56 €` (German), `€1,234.56` (English), `1 234,56 €` (Bulgarian), with dates such as `31.10.2026` or `31/10/2026`. The currency itself always comes from the workspace setting, never from the language (OD-18).
- Plural rules are applied per language.
- **Phasing (MKT-2):** every language is built in from the start, but each one is switched on separately, only when its UI translations, security emails and legal documents are reviewed. Switched-off languages can't be selected. English is always on. **At launch only English is switched on**; the other six follow one by one.
- Three scripts are supported: Latin, Cyrillic and Greek. Fonts must cover all three (Annex L item 19).
- Layouts tolerate text that is longer than English (German and Greek labels can be much longer) without truncating amounts.
- Stored data uses language-neutral keys. Default category names are translations of system keys, while user-created names are stored as typed.
- Search is case-insensitive and accent-insensitive across Latin, Cyrillic and Greek (for example "cafe" finds "Café", and Greek words match with or without accent marks).
- Legal documents and security emails exist in every UI language before that language goes live (LQ-10).

**Acceptance criteria:**
- AC-22.1: No hard-coded user-visible strings, and no missing translation in any switched-on language (automated check).
- AC-22.3: Every Must Have screen passes a layout check in every switched-on language at 360 px, with no truncated amounts.
- AC-22.4: A search for an unaccented word finds accented matches in Latin and Greek text.
- AC-22.2: The CSV import accepts both `1 234,56` and `1234.56` according to the mapping profile.

---

#### FR-23 · Workspace currency (EUR or USD): **Must** / more than one currency per workspace: **Later** (design constraints are **Must**)

**Behavior and rules (CUR-1):**
- BR-23.1: At workspace creation the user chooses **EUR** (default) or **USD**. No other currency can be chosen.
- BR-23.2: The workspace currency is **locked once the first transaction exists**. Changing it would mean converting history, which isn't supported; the user would start a new workspace instead (OD-17).
- BR-23.3: Every account, posting, budget, goal, rule and report in a workspace uses the workspace currency. An account can't have a different currency.
- BR-23.4: CSV import: if the file has a currency column, rows in any other currency (including BGN) are rejected with a clear message. Files without a currency column are assumed to be in the workspace currency, and the preview states this.
- BR-23.5: All money rules (integer cents, rounding, golden tests) apply identically to EUR and USD.

**Constraints that keep multi-currency possible later:**
- Every account and posting stores a currency code.
- The workspace stores its currency as the reporting currency.
- The balancing invariant is stated per currency.
- Postings have reserved fields for original amount, original currency and the rate reference.
- No feature may assume that two amounts are in the same currency without checking.

**Acceptance criteria:**
- AC-23.1: A Stage 2 architecture review checklist confirms the constraints above.
- AC-23.2: The full golden suite passes in a USD workspace with identical numbers (GT-70).
- AC-23.3: Changing the currency of a workspace that has transactions is rejected (GT-71).

---

#### FR-24 · Future household workspaces and commercial subscriptions: **Later** (design constraints are **Must**)

**MVP constraints:**
- Data is owned by the workspace (BR-02.2).
- Membership has a role field (MVP: Owner only).
- Feature entitlements are checked through a single entitlement mechanism, even if every MVP user has all features.
- Audit entries record the acting user, not just the workspace.

**Acceptance criteria:**
- AC-24.1: An architecture review confirms that adding a second member to a workspace requires no change to financial data structures.

---

### 3.5 Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-01 | Financial accuracy | Zero tolerance for errors. All golden scenarios pass before any release. A nightly integrity job verifies that every transaction balances, that any cached balances equal the derived ones, and that the Net Worth Change identity holds. |
| NFR-02 | Precision | Integer cents for EUR. No binary floating point anywhere in money paths (§10). |
| NFR-03 | Performance | Transaction save p95 < 500 ms. Dashboard p95 < 1.5 s and reports p95 < 3 s, at 50,000 transactions per workspace. Import of 2,000 rows in < 10 s. |
| NFR-04 | Availability | 99.5% monthly target for the MVP, plus a planned-maintenance notice. |
| NFR-05 | Backup and recovery | RPO ≤ 1 hour (target), RTO ≤ 8 hours. Restore is tested at least quarterly (§11). |
| NFR-06 | Security | Meets OWASP ASVS Level 2 as the baseline (§11). |
| NFR-07 | Privacy | No third-party trackers inside authenticated pages. Logs never contain amounts, descriptions or payees. |
| NFR-08 | Accessibility | WCAG 2.1 AA as the target. Charts have table equivalents. Whether the European Accessibility Act applies is a legal question (§11). |
| NFR-09 | Browser support | The last 2 versions of evergreen browsers, plus iOS Safari 16+. |
| NFR-10 | Maintainability | Financial rules live in one isolated domain layer, with coverage of every rule in §5. No financial logic in UI components. |
| NFR-11 | Data volume assumption | Up to 30 accounts, 10,000 transactions per year and 10 years of history per workspace. |
| NFR-12 | Observability | Errors and performance are monitored without financial payloads. Integrity-job failures alert the operator. |

### 3.6 MVP boundary summary

| Must (MVP) | Should (MVP if capacity allows, otherwise release 1.1) | Could | Later |
|---|---|---|---|
| FR-01 to FR-12, FR-14, the FR-15 core, FR-16, FR-17, FR-18, FR-19, FR-21 responsive, FR-22 in 7 languages, phased (MKT-1, MKT-2), and the FR-23/FR-24 design constraints. Includes R5 / "Save for a bill" (AP-03, SC-3), the payday marker (SC-2), G-P4, and the matching rules M-1 to M-8 | Investment accounts, tags, the monthly plan summary, goal projections, calendar grid, FR-13 projection, extra reports, in-app notifications, Excel import, installable PWA, English, TOTP 2FA, Transfers in Transit, the weekend non-working-day setting (SC-1), payday auto-suggestions | Budget rollover (opt-in per category), IBAN masking | Zero-based mode, more than one currency per workspace, households, billing, email and push notifications, amortization, card statements, partial-payment occurrences, public-holiday shifting, bank APIs, PDF and Excel export, scenarios, offline use, passkeys |

**Why each Must is necessary:**
- Without accounts, transactions, splits, refunds and transfers, the ledger can't be correct.
- Without CSV import, real usage is rare (manual entry fatigue).
- Without reconciliation, users can't trust the numbers.
- Without recurring items and the upcoming list, Safe to Spend has no obligations to subtract.
- Without goals and allocations, Safe to Spend overstates spendable money (confirmed decision C-3).
- Budgets and the dashboard are the core value.
- Export and audit are trust and GDPR baselines.
- Isolation and authentication are non-negotiable.

**Main scope risk:** the Must list is large for a first release. The approved contingency cut order (I-14, AP-07) is in §12.1; each cut keeps financial correctness intact. FR-09 virtual allocations stay in scope (confirmed decision C-3).

---

## 4. Budgeting model comparison

### 4.1 The two models

- **Traditional category-based ("limits").** The user sets a monthly limit per category, and the app compares actual spending against it. Money itself isn't assigned anywhere; the budget is a *plan to compare against*.
- **Zero-based / envelope ("every euro has a job").** Every euro of cash on hand is assigned to an envelope: categories, savings targets, card payments, buffer.
  - "Ready to Assign" = cash − Σ envelope balances. It must reach exactly 0.
  - Overspending one envelope must be covered by moving money from another.
  - Envelope balances roll over automatically.
  - Card purchases move money from the spending envelope into a "card payment" envelope.

### 4.2 Worked monthly example (identical inputs for both models)

**Starting state on 1 October:** Current account €500.00, Savings €0.00, Card owed €0.00. Loan owed €8,000.00 (ignored for net worth here; it's included in §6).

**Plan for October:**

| Item | Planned |
|---|---|
| Salary (income) | 2,000.00 |
| Rent | 600.00 |
| Utilities | 150.00 |
| Loan installment | 300.00 (principal 250.00 + interest 50.00) |
| Food | 350.00 |
| Transport | 120.00 |
| Entertainment | 100.00 |
| Shopping | 80.00 |
| Savings: emergency fund | 200.00 |
| Savings: vacation | 100.00 |

Check: expense budgets total 600 + 150 + 50 + 350 + 120 + 100 + 80 = **1,450.00**. Adding principal 250 and savings 300 gives 2,000.00, which equals the salary.

**Actual October activity:**
- Salary €2,000.00 into the current account.
- Rent €600.00, utilities €162.00, loan installment €300.00 (€250.00 principal + €50.00 interest), food €390.00, transport €105.00 and entertainment €60.00, all from the current account.
- Shopping €80.00 **on the credit card**, then a **€20.00 refund** to the card.
- €300.00 transferred to the savings account, for the emergency fund and vacation.

**Ledger results** (identical under both models; budgeting never changes the ledger):

- Expenses = 600 + 162 + 50 + 390 + 105 + 60 + (80 − 20) = **€1,427.00**
- Income = **€2,000.00**. Net Result = **€573.00**.
- Current account: 500 + 2,000 − 600 − 162 − 300 − 390 − 105 − 60 − 300 = **€583.00**
- Savings €300.00. Card owed €60.00. Cash Balance = 583 + 300 = **€883.00**.
- Net worth change, excluding the loan: +€573.00 (expenses) + €250.00 principal reduces the loan, so the total NW change = Net Result 573 ✓. Principal is a transfer, so it doesn't add on top: the cash decrease and the liability decrease cancel.

**A. Traditional view, end of October:**

| Category | Limit | Spent | Remaining | Status |
|---|---|---|---|---|
| Rent | 600 | 600 | 0 | 100% |
| Utilities | 150 | 162 | −12 | 108%, over |
| Interest | 50 | 50 | 0 | 100% |
| Food | 350 | 390 | −40 | 111%, over |
| Transport | 120 | 105 | 15 | 88% |
| Entertainment | 100 | 60 | 40 | 60% |
| Shopping | 80 | 60 (80 − 20 refund) | 20 | 75% |
| **Total** | **1,450** | **1,427** | **23** | 98% |

- The goals (separate from budgets) are €300 allocated to Emergency (€200) and Vacation (€100) on the Savings account, which is a dedicated account or virtual allocations.
- Overspending is *visible* but has no mechanical consequence.
- The leftover €23 isn't "money". It's just an under-run.
- The €60 card debt is visible as a liability and is reserved in Safe to Spend.

**B. Zero-based view, end of October:**

At the start, Ready to Assign = €500 (existing cash) + €2,000 (salary). The user assigns €2,000 as planned, plus €500 to "Buffer".

| Envelope | Assigned | Activity | Moves | Available |
|---|---|---|---|---|
| Buffer | 500 | 0 | 0 | 500 |
| Rent | 600 | −600 | 0 | 0 |
| Utilities | 150 | −162 | +12 from Transport | 0 |
| Interest | 50 | −50 | 0 | 0 |
| Loan principal | 250 | −250 | 0 | 0 |
| Food | 350 | −390 | +40 from Entertainment | 0 |
| Transport | 120 | −105 | −12 to Utilities | 3 |
| Entertainment | 100 | −60 | −40 to Food | 0 |
| Shopping | 80 | −80 + 20 | 0 | 20 |
| Card payment | 0 | +80 − 20 (automatic) | 0 | 60 |
| Emergency fund | 200 | 0 | 0 | 200 |
| Vacation | 100 | 0 | 0 | 100 |
| **Total** | **2,500** | | | **883** |

The envelope total is €883, which equals the cash on hand (583 + 300). The zero-based identity holds: Σ envelopes + Ready to Assign (0) = cash. The card debt of €60 is exactly covered by the Card payment envelope.

**What the comparison shows:**
- Zero-based *forces* a decision on the €52 of overspending, while traditional only flags it.
- Zero-based needs a deliberate decision about the €500 starting cash. Traditional ignores it, and Safe to Spend has to supply that answer instead.
- Zero-based needs an automatic card-payment envelope to handle cards correctly. Traditional needs nothing special.
- Both models produce the *same* ledger, reports and net worth.

### 4.3 Comparison against the required criteria

| Criterion | Traditional | Zero-based / envelope |
|---|---|---|
| Ease for non-experts | High. A familiar "limit per category" idea. | Medium to low. "Assign money you already have" and "Ready to Assign" need teaching, and churn is high in the first weeks. |
| Initial setup | Fast: pick categories and limits, or accept suggestions from history. | Slower: all existing cash must be assigned, including card debt already outstanding. |
| Day-to-day tracking | Simple: transactions just consume limits. | Same entry, plus continuous rebalancing of envelopes. |
| Monthly planning | Limits plus an optional monthly plan summary. | Strong. Assignment *is* the planning. |
| Overspending | Shown as over budget, with no enforced consequence. | Must be covered from another envelope, or it reduces next month's Ready to Assign. Disciplined, but complex to explain. |
| Savings and goals | Separate goal allocations (§8) are needed. | Native: goals are envelopes. |
| Card purchases | Expense at purchase. Card debt is a liability; nothing special. | Needs an automatic card-payment envelope. Pre-existing card debt needs special onboarding. |
| Refunds | Reduce Spent in the refund month. | Return money to the envelope (and adjust the card envelope if the refund went to a card). |
| Rollover | Optional, as an add-on with its own rules. | Inherent and automatic. |
| Reporting | Budget vs actual is straightforward. | "Assigned vs activity vs available" is harder to read, and history depends on assignment moves. |
| Implementation complexity | Low to medium. | High: assignment ledger, moves, card envelope automation, Ready to Assign, negative carryover, month-close semantics. |
| Commercial fit | Broad market (the Mint and Wallet style). | Loyal niche that pays well (the YNAB style), but it needs onboarding and education. |

### 4.4 Can they coexist?

**In the data model, yes.** Both are planning layers over one ledger. Neither changes balances, so ledger correctness is unaffected.

**In the UI, not simultaneously.** "Remaining budget" (traditional) and "Available in envelope" (zero-based) answer different questions with different numbers. Showing both would confuse non-experts and undermine trust.

The safe approach is a **workspace-level mode**, with exactly one mode active at a time:
- Switching modes doesn't alter transactions.
- Switching from traditional to zero-based requires a guided "assign your current cash" step.
- Switching back simply hides the envelopes.

**Compatibility condition:** virtual goal allocations (§8) must be designed as a subset of envelope semantics: earmarked cash amounts with backing rules. In a future zero-based mode, goal allocations then become envelopes without migrating any data.

### 4.5 Recommendation

1. **MVP model:** traditional monthly category budgets, plus virtual goal allocations, plus the monthly plan summary (Should). No rollover in the MVP.
2. **Reasons:**
   - The target users are non-experts, so onboarding friction matters most.
   - Import-centric usage, where transactions arrive after the fact, fits tracking better than forward assignment.
   - The key benefit of zero-based budgeting, knowing how much is genuinely free, is delivered *for everyone* by Safe to Spend plus allocations, without forcing the envelope workflow.
   - It's materially less complex, which frees capacity for correctness work.
3. **Trade-offs:**
   - Traditional budgeting changes behaviour less: overspending has no forced consequence.
   - The zero-based audience may see the product as "just a tracker" until a zero-based mode exists.
   - Without rollover, irregular categories (annual insurance) need goal allocations instead. That's acceptable and arguably clearer.
4. **Approved decisions:**
   - **B-1:** The MVP budgeting model is traditional.
   - **B-2:** Refunds count in the refund month (confirmed again by I-9).
   - **B-3:** Rollover is deferred to Could/Later.
   - **B-4:** Budgets at either the parent level or the subcategory level within a branch, never both.
   - **B-5:** Zero-based mode is on the long-term roadmap as an optional workspace mode, so Stage 2 keeps allocations "envelope-ready".

---

## 5. Accounting Rulebook

### 5.1 Purpose and scope

This rulebook defines every way money can be recorded, and how each recording affects every number the product shows. It's binding on all later stages. If the code and this rulebook ever disagree, the code is wrong.

### 5.2 Core ledger rules

| ID | Rule |
|---|---|
| LR-01 | **Balancing:** the postings of every transaction sum to exactly 0 in integer cents, per currency. |
| LR-02 | Every transaction has at least 2 postings. Every posting is non-zero. Every transaction has at least one posting to a user account (asset or liability). |
| LR-03 | **Atomicity:** a transaction and all its postings are saved or rejected together. A failure leaves no partial postings. Linked side effects in the same user action (occurrence completion, allocation release, import-row link) are part of the same atomic operation. |
| LR-04 | **One date per transaction.** All postings share the transaction date. It's a calendar date in the workspace timezone, not in the future, and not before the opening date of any account it touches. |
| LR-05 | **Equity accounts are system-only:** OBE is posted only by Opening Balance, ADJ only by Balance Adjustment, and VAL only by Valuation. Users can't choose an equity account in any form. |
| LR-06 | **Transfers have no income or expense line for the transferred amount.** Optional fee lines are expense lines in the same transaction, paid by the source account. |
| LR-07 | **Planned occurrences have no postings.** They can never affect a balance, Income, Expenses or Net Worth. |
| LR-08 | **Allocations are not postings.** Goal allocations never affect any ledger metric. |
| LR-09 | **Only actual transactions count.** Every metric uses only posted, non-voided, non-trashed transactions. |
| LR-10 | **Edits replace postings atomically** and record a version (before and after values). Reconciled transactions are locked until explicitly unlocked. |
| LR-11 | **Void instead of reversing entries.** A correction voids or edits the original. The audit trail preserves history. Reasons are in §5.7, item 1. |
| LR-12 | **Valuation postings are derived from a stated value.** A Valuation stores the user's stated value V on date d. Its posting = V − Bal(account, d excluding this valuation), recomputed whenever an earlier-dated posting to that account changes. Valuations apply only to Investment and Other-asset accounts. |
| LR-13 | **Adjustment postings are fixed amounts.** A Balance Adjustment is never recomputed automatically. That would silently hide later errors. |
| LR-14 | **Archived objects can't receive postings.** An archived account or category can't be used in new or edited transactions until it's unarchived. |
| LR-15 | **Refund direction:** an expense-category credit or an income-category debit is allowed only in a Refund/Reversal transaction, or as an explicitly marked discount or deduction line inside a split. This prevents accidental sign errors from being saved. |
| LR-16 | **Single source of truth for reports:** all reports, dashboard widgets, exports and Safe to Spend read the same posting data through the canonical definitions in §2.3. No feature keeps its own running totals. |
| LR-17 | **Money precision:** postings are integer cents. Any calculation producing fractions (splits by percentage, future conversions) resolves cents with the rules in §10 *before* posting. |
| LR-18 | **Account-class rules:** only Cash-class accounts can be spendable. Valuation only applies to Investment and Other-asset accounts. Card reserve only applies to Credit-card accounts. |

### 5.3 How effects are derived (generic; not coded per transaction kind)

The effects in §5.6 aren't hand-written rules for each kind. They follow mechanically from the postings. That's the main protection against inconsistency: if the postings are right, every metric is right.

For any set of actual postings in period P:

| Metric | Derivation from postings |
|---|---|
| ΔAssets | Σ postings to asset accounts (including TIT) |
| ΔLiabilities | −Σ postings to liability accounts |
| Income | −Σ postings to income categories |
| Expenses | Σ postings to expense categories |
| ΔCash (Cash Change) | Σ postings to Cash-class accounts, excluding Opening Balance transactions |
| ΔNet Worth | ΔAssets − ΔLiabilities, which is identical to Income − Expenses − Σ(equity postings). From LR-01: all postings sum to 0. |
| Budget Spent(c, M) | Σ expense postings in category subtree c with date in month M |
| Goal progress | Not derived from postings: derived from allocations plus balances (§8) |
| Safe to Spend | Recomputed from current state with the §2.3 formula. Never incremented. |

The **Net Worth identity** follows: ΔNW = Net Result + (−ΣOBE) + (−ΣADJ) + (−ΣVAL). Every unexplained change in net worth therefore appears as exactly one of four labelled sources.

### 5.4 Allowed posting patterns per user-facing kind

| Kind | Required lines | Optional lines | Forbidden |
|---|---|---|---|
| Expense | 1 user account (credit) + ≥1 expense category (debit) | Discount lines (marked) | Income and equity lines |
| Income | 1 user account (debit) + ≥1 income category (credit) | Deduction lines (marked expense) | Equity |
| Transfer | Exactly 2 different user accounts (source credit, destination debit) | Fee expense lines | Income and equity lines |
| Refund / Reversal | 1 user account + the reversing category line(s). Can link to the original. | Further reversing lines | Equity |
| Debt payment | Source account (credit) + liability account (debit, principal) | Interest and fee expense lines | Income and equity lines |
| General split | ≥1 user account + any mix of category and user-account lines, balanced | — | Equity |
| Opening Balance (system) | 1 user account + OBE | — | Everything else |
| Balance Adjustment (system) | 1 user account + ADJ, **or** 1 user account + a user-chosen category (§5.6, E-37) | — | Other equity |
| Valuation (system) | 1 Investment or Other-asset account + VAL | — | Everything else |

### 5.5 Default configuration used in all examples

| Account | Class | Spendable | Other |
|---|---|---|---|
| Current | Cash | Yes | — |
| Cash wallet | Cash | Yes | — |
| Savings | Cash | No | — |
| Card | Liability (credit card) | — | Reserve balance in Safe to Spend = **on** |
| Loan | Liability (loan) | — | — |
| Investment | Investment | No | — |

- Protected reserve = €0. There are no allocations and no planned occurrences unless an example says otherwise.
- **STS effects** are the change in Safe to Spend under this configuration, recomputed from the §2.3 formula.
- **Card reserve** (clarifying §2.3): the reserved amount per card is **max(0, amount owed)**. An overpaid card contributes 0, never a negative reserve.

**Effect line legend:**
- ΔA = Assets, ΔL = Liabilities, Inc = Income, Exp = Expenses, ΔCash = Cash Change, ΔNW = Net Worth.
- **Standard lifecycle** = editable (locked once reconciled), voidable, deletable to the trash, and reconcilable as a cleared item.
- "—" = no effect.

### 5.6 Event catalogue

#### A. Setup

**E-01 · Opening balance, asset account**
Example: Current opened on 1 March with €1,000.00.
- Postings: Current +1,000.00 · OBE −1,000.00 · Σ = 0
- Effects: ΔA +1,000 · ΔL — · Inc — · Exp — · ΔCash — (opening balances are excluded) · ΔNW +1,000 (labelled as OBE) · Budget — · Goals — · STS +1,000 (ELF)
- Actual, system-generated.
- Lifecycle: edited only through account settings (versioned). Can't be voided on its own. Counts as cleared for reconciliation.
- Variant: a Savings opening balance → STS — (not spendable).

**E-02 · Opening balance, liability account**
Example: Card owed €300.00. Loan owed €8,000.00.
- Postings: Card −300.00 · OBE +300.00. Loan −8,000.00 · OBE +8,000.00.
- Effects: ΔA — · ΔL +8,300 · Inc and Exp — · ΔCash — · ΔNW −8,300 (OBE) · Budget — · Goals —
- STS −300: the card balance is reserved. The loan isn't, because only its due installments count.
- Lifecycle as in E-01.

**E-03 · Editing an opening balance or opening date**
- The OBE posting is replaced atomically.
- All balances from the opening date onward shift by the difference.
- Any reconciliation whose cleared balance changes is flagged **broken**.
- Moving the opening date later than an existing transaction is rejected (LR-04).
- ΔNW changes only in the OBE source. Income and Expenses never change.

#### B. Everyday income and spending

**E-04 · Income into a bank account**
Example: salary €2,000.00.
- Postings: Current +2,000.00 · Salary −2,000.00
- Effects: ΔA +2,000 · Inc +2,000 · ΔCash +2,000 · ΔNW +2,000 · Budget — (it appears in the monthly plan's actual income) · Goals — · STS +2,000 (ELF)
- Actual, standard lifecycle.
- **Note:** if this transaction completes the *payday* income occurrence that defined H, then H moves to the next payday. UCO may then *increase*, because the next period's obligations come into the horizon. STS therefore rises by €2,000 minus the newly included obligations. That's intended behaviour (§7).
- Variant (cash income): Cash wallet instead of Current, with the same effects.

**E-05 · Expense paid from a bank account**
Example: groceries €45.60.
- Postings: Current −45.60 · Food +45.60
- Effects: ΔA −45.60 · Exp +45.60 · ΔCash −45.60 · ΔNW −45.60 · Budget Food +45.60 · Goals — · STS −45.60
- Actual, standard lifecycle.
- If Current holds allocations, see E-47: STS may fall by less, and a goal shortfall appears instead.

**E-06 · Expense paid with cash**
Example: market €12.00.
- Postings: Cash wallet −12.00 · Food +12.00
- Effects are the same as E-05, using the Cash wallet.

**E-07 · Split expense**
Example: supermarket €120.00 = Food 80.00 + Household 30.00 + Personal care 10.00.
- Postings: Current −120.00 · Food +80.00 · Household +30.00 · Personal care +10.00
- Effects: ΔA −120 · Exp +120 · ΔCash −120 · ΔNW −120 · Budget per line (Food +80, Household +30, Personal care +10) · STS −120
- Rule: reports and budgets use line amounts (BR-06.5).

**E-08 · Bank fee**
Example: monthly account fee €3.50.
- Postings: Current −3.50 · Bank fees +3.50
- Effects: ΔA −3.50 · Exp +3.50 · ΔCash −3.50 · ΔNW −3.50 · Budget Bank fees +3.50 · STS −3.50

**E-09 · Interest earned on savings**
Example: €4.20 net of withholding tax.
- Postings: Savings +4.20 · Interest income −4.20
- Effects: ΔA +4.20 · Inc +4.20 · ΔCash +4.20 · ΔNW +4.20 · STS — (Savings isn't spendable)
- If Savings is a dedicated goal account, goal progress rises by 4.20.
- Rule: record the net amount by default. Gross amount plus tax line is optional as a split (§5.8, item 5).

#### C. Transfers between the user's own accounts

**E-10 · Transfer to savings (spendable → non-spendable)**
Example: €200.00 from Current to Savings.
- Postings: Current −200.00 · Savings +200.00
- Effects: ΔA — · ΔL — · Inc and Exp — · ΔCash — (both are Cash class) · ΔNW — · Budget —
- Goals: if Savings is dedicated to a goal, +200.
- STS −200 (ELF falls). If a planned savings-transfer occurrence was in UCO and this transaction completes it, UCO also falls by 200, so the net STS change is 0.

**E-11 · Transfer between two spendable accounts**
Example: €150.00 from Current to a second current account.
- Every ledger metric: —. STS — (always, AM-2): under AM-1, allocations on spendable accounts are subtracted in full, so moving money between spendable accounts never changes STS.
- Allocations don't move with money. If Current held allocations and its balance now falls below them, the goal shows a shortfall (E-47), but STS is unchanged. The UI offers "move the allocation too" (§8).

**E-12 · Transfer with a fee**
Example: €500.00 to Savings at another bank, fee €1.50.
- Postings: Current −501.50 · Savings +500.00 · Bank fees +1.50
- Effects: ΔA −1.50 · Exp +1.50 · ΔCash −1.50 · ΔNW −1.50 · Budget Bank fees +1.50 · STS −501.50
- Only the fee is an expense (LR-06).

**E-13 · ATM cash withdrawal**
Example: €100.00 withdrawn, ATM fee €2.00.
- Postings: Current −102.00 · Cash wallet +100.00 · Bank fees +2.00
- Effects: ΔA −2.00 · Exp +2.00 · ΔCash −2.00 · ΔNW −2.00 · Budget Bank fees +2.00 · STS −2.00 (both accounts are spendable)
- The withdrawal itself is not spending. Spending happens later, from the wallet (E-06).

**E-14 · Cash deposit**
Example: €300.00 from the wallet into Current.
- Postings: Cash wallet −300.00 · Current +300.00
- Every metric: —. STS —.

**E-15 · Transfer in transit across a month boundary** (TIT is a Should Have)
Example: €1,000.00 sent on 31 January, credited to Savings at another bank on 2 February.
- T1 (31 January): Current −1,000.00 · TIT +1,000.00
- T2 (2 February): TIT −1,000.00 · Savings +1,000.00
- **Clarification of §2.3:** TIT is classified as **Cash class, not spendable, system**. Money in flight is still the user's cash, so ΔCash stays 0 for both January and February.
- Effects of each step: ΔA — · Inc and Exp — · ΔCash — · ΔNW —
- STS: −1,000 at T1, then — at T2.
- MVP without TIT: one transfer dated 31 January. On 31 January, the Savings ledger shows €1,000 more than the bank does. Reconciling Savings as of 31 January shows the difference, and the user reconciles as of 2 February instead. This is documented as a known MVP limitation.

**E-16 · Both sides of a transfer arrive by import**
Example: Current CSV row "−200.00, to savings". Savings CSV row "+200.00, from current".
- **Wrong outcome to prevent:** an expense of 200 plus income of 200. Net worth would be right, but Income and Expenses would both be inflated by 200.
- Rule:
  1. The first imported side is suggested as a Transfer to the paired account, creating E-10 postings.
  2. The Savings-side posting now already exists.
  3. When the Savings CSV is imported, its +200 row is classified as **"already recorded: part of transfer #T"**. It's linked, and no new transaction is created.
- Duplicate detection must therefore compare imported rows against *all existing postings on the target account*, not only against earlier import rows (§9).

#### D. Credit cards

**E-17 · Credit card purchase**
Example: shopping €80.00.
- Postings: Card −80.00 · Shopping +80.00
- Effects: ΔA — · ΔL +80 · Exp +80 (counted at the purchase date) · ΔCash — · ΔNW −80 · Budget Shopping +80 · Goals — · STS −80 (the card reserve rises)
- If card reserve is off: STS — now. The later repayment occurrence counts in UCO when it's due within H.

**E-18 · Credit card full repayment**
Example: €80.00.
- Postings: Current −80.00 · Card +80.00
- Effects: ΔA −80 · ΔL −80 · Inc and Exp — (**never a second expense**) · ΔCash −80 · ΔNW — · Budget —
- STS — (ELF −80 and card reserve −80).
- A planned "card payment" occurrence *to a reserved card* is excluded from UCO (§2.3), so completing it changes nothing further. No double subtraction.

**E-19 · Credit card partial repayment**
Example: €50.00 of €80.00 owed.
- Postings: Current −50.00 · Card +50.00
- Effects: ΔL −50 · ΔCash −50 · ΔNW — · STS — (the remaining 30 is still reserved)

**E-20 · Credit card refund (partial)**
Example: €20.00 of an €80.00 purchase.
- Postings: Card +20.00 · Shopping −20.00 (Refund kind, linked to E-17)
- Effects: ΔL −20 · Exp −20 · ΔNW +20 · Budget Shopping −20 (Spent 80 → 60) · STS +20 (reserve 80 → 60)
- **Not income** (mandatory invariant).

**E-21 · Credit card interest and annual fee**
Example: interest €12.40, annual fee €30.00.
- Postings: Card −42.40 · Interest and fees +42.40 (or split into Interest 12.40 and Card fees 30.00)
- Effects: ΔL +42.40 · Exp +42.40 · ΔNW −42.40 · Budget +42.40 to the chosen categories · STS −42.40

**E-22 · Cash advance on a credit card**
Example: €200.00 withdrawn, fee €6.00.
- Postings: Card −206.00 · Cash wallet +200.00 · Interest and fees +6.00
- Effects: ΔA +200 · ΔL +206 · Exp +6 · ΔCash +200 · ΔNW −6 · Budget +6
- STS −6: ELF +200, card reserve +206. Borrowed cash doesn't raise STS while the card is reserved.

**E-23 · Credit card overpayment**
Example: €30.00 owed, €50.00 paid.
- Postings: Current −50.00 · Card +50.00 → the card now has a €20.00 credit balance (owed = −20)
- Effects: ΔA −50 · ΔL −50 (Liabilities fall 30 to 0, then the credit reduces total Liabilities by a further 20) · ΔCash −50 · ΔNW —
- STS −20: ELF −50, reserve max(0, 30) → max(0, −20), so −30. The 20 sitting on the card isn't spendable cash.

**E-24 · Card instalment plan purchase** (common in Bulgaria)
Example: TV €600.00 on 6 × €100.00, 0% interest.
- **Recommended model:** the plan is a separate **Loan-type liability** ("TV plan"). The expense is recognized in full at purchase. Repayments are E-28-style payments without interest.
  - Purchase postings: TV plan −600.00 · Electronics +600.00
  - Effects: ΔL +600 · Exp +600 · ΔNW −600 · Budget Electronics +600 (purchase month)
  - STS: — at purchase (Loan-type accounts aren't reserved). Each €100 installment counts in UCO when due within H.
- Why not post it to the reserved card: the reserve would subtract the full 600, although only 100 per month is due. That's over-conservative and confusing.
- **Approved (D-15, I-6):** the full expense counts in the purchase month, including for budgets, with a one-line note on the overspent budget (BR-07.13). Spreading for budgets only may be revisited after real user feedback.

#### E. Loans and personal debts

**E-25 · Loan disbursed into a bank account**
Example: €10,000.00 consumer loan.
- Postings: Loan −10,000.00 · Current +10,000.00
- Effects: ΔA +10,000 · ΔL +10,000 · Inc — (**borrowing is never income**) · ΔCash +10,000 · ΔNW — · STS +10,000 (ELF)
- Note: borrowed money in a spendable account is spendable by definition. If it's earmarked (for a renovation, say), the user should allocate it. The UI suggests this on any Loan → Cash transfer above €1,000.

**E-26 · Loan paid directly to a seller**
Example: car €15,000.00, financed in full.
- **Option A, expense (default):** Loan −15,000.00 · Vehicle purchase +15,000.00
  - Effects: ΔL +15,000 · Exp +15,000 · ΔNW −15,000 · Budget +15,000
- **Option B, asset:** Loan −15,000.00 · Car (Other asset) +15,000.00
  - Effects: ΔA +15,000 · ΔL +15,000 · Exp — · ΔNW —
  - Later declines in value go through Valuation (E-43), not Expenses.
- STS: — for both.
- **Open decision D-16:** the default treatment for large durable purchases. Option B gives a truer net worth but needs ongoing valuations.

**E-27 · Loan installment (principal + interest + fee)**
Example: €400.00 = principal 320.00 + interest 75.00 + fee 5.00.
- Postings: Current −400.00 · Loan +320.00 · Interest and fees +75.00 · Loan fees +5.00
- Effects: ΔA −400 · ΔL −320 · Exp +80 (**only interest and fees**) · ΔCash −400 · ΔNW −80 · Budget +80 to the interest and fee categories
- STS: if this completes a planned installment that was in UCO, it's — (ELF −400, UCO −400). If it was unplanned, −400.

**E-28 · Extra or early principal repayment**
Example: €1,000.00, plus a €20.00 early repayment fee.
- Postings: Current −1,020.00 · Loan +1,000.00 · Loan fees +20.00
- Effects: ΔL −1,000 · Exp +20 · ΔCash −1,020 · ΔNW −20 · STS −1,020

**E-29 · Money borrowed from a person, then repaid**
Example: €500.00 from Ivan in cash.
- Borrowing: "Owed to Ivan" (Other liability) −500.00 · Cash wallet +500.00
  - Effects: ΔA +500 · ΔL +500 · ΔNW — · STS +500
- Repayment: the reverse postings, with every effect reversed.
- **Never** income or expense.

**E-30 · Money lent to a person (repaid, shared bill, or written off)**
- **Lending €300.00:** "Lent to Maria" (Other asset) +300.00 · Current −300.00
  - Effects: ΔA — · ΔCash −300 · ΔNW — · STS −300
- **Repayment:** the reverse.
- **Shared bill:** the user pays €120.00 for dinner, and friends will return €80.00.
  - Postings: Current −120.00 · Food +40.00 · "Lent to friends" +80.00
  - Effects: Exp +40 only · Budget Food +40 · ΔNW −40 · STS −120
- **Write-off** (Maria won't repay): "Lent to Maria" −300.00 · Gifts and losses +300.00
  - Effects: Exp +300 · ΔNW −300 · STS —

#### F. Refunds, reversals and corrections

**E-31 · Full refund to a bank account**
Example: €59.99 Shopping purchase refunded in full.
- Postings: Current +59.99 · Shopping −59.99 (linked)
- Effects: ΔA +59.99 · Exp −59.99 · ΔCash +59.99 · ΔNW +59.99 · Budget Shopping −59.99 · STS +59.99

**E-32 · Partial refund**
Example: 1 of 3 items returned, €15.00 of €45.00.
- Postings: Current +15.00 · Clothing −15.00
- Net effect: Clothing spending for the purchase becomes €30.00. Every other effect is analogous to E-31.

**E-33 · Refund in a later month**
Example: €100.00 bought on 25 January, refunded on 3 February.
- January: Exp +100. February: Exp −100. February's category Spent can be negative.
- Rule (B-2, I-9, approved): refunds count in the **refund month**. Closed months never change retroactively.
- Over January and February combined, Expenses = 0.

**E-34 · Refund to a different account than the one used to pay**
Example: paid €80.00 by card, refund arrives in Current.
- Postings: Current +80.00 · Shopping −80.00
- Effects: Exp −80 · ΔCash +80 · ΔNW +80. The card **still owes 80** and must be repaid by transfer.
- STS +80 (ELF). The card reserve is unchanged at 80, so overall STS goes back to where it was before the purchase.

**E-35 · Income reversal**
Example: the employer recalls a €150.00 overpayment.
- Postings: Current −150.00 · Salary +150.00 (Reversal kind)
- Effects: Inc −150 in the month of the reversal · ΔCash −150 · ΔNW −150 · STS −150
- Not an expense.

**E-36 · Balance adjustment from reconciliation (unexplained difference)**
Example: ledger €1,251.17, statement €1,243.17.
- Postings: Current −8.00 · ADJ +8.00
- Effects: ΔA −8 · Inc and Exp — · ΔCash −8 · ΔNW −8 (labelled "Unexplained adjustments" in the Net Worth change breakdown) · Budget — · STS −8
- **It doesn't silently distort Income or Expenses, and it isn't hidden either.** It's always visible as its own line in net worth reports and on the dashboard drill-down.
- Lifecycle: it can be voided only by unlocking or reopening its reconciliation.

**E-37 · Adjustment classified as spending**
Example: wallet counted at €40.00, ledger says €75.00, and the user says "I spent it".
- Postings: Cash wallet −35.00 · Untracked spending (expense) +35.00
- Effects: Exp +35 · Budget: Untracked spending (or a category the user chooses) +35 · ΔNW −35 · STS −35
- The user explicitly chooses between E-36 and E-37. The default prompt in the UI explains the difference.

**E-38 · Editing a posted transaction**
Example: Food expense corrected from €45.60 to €54.60, or moved to another month or account.
- The postings are replaced atomically (LR-10). The effect equals the difference: Exp +9.00, ΔCash −9.00, STS −9.00.
- Changing the date moves the effect between periods.
- Budget threshold events are re-evaluated with no repeated notification (AC-07.2).
- Changing the account from Current to Card moves the effect from Assets to Liabilities.
- A version entry is recorded. Reconciled transactions must be unlocked first (E-40).

**E-39 · Void, delete and restore**
- Voiding or trashing removes every effect of the transaction, and restoring brings them back exactly.
- If the transaction completed an occurrence, the occurrence returns to Planned or Overdue, so UCO rises again and STS falls (correct).
- If the voided transaction is the original of a linked refund, the refund remains with a warning ("original purchase was removed").

**E-40 · Correcting a reconciled transaction**
- The user must unlock it, which is audited.
- The reconciliation becomes **broken** until it's redone.
- The edit itself follows E-38.

#### G. Investments (Should Have)

**E-41 · Investment contribution**
Example: €300.00 from Current to Investment, broker fee €2.00.
- Postings: Current −302.00 · Investment +300.00 · Investment fees +2.00
- Effects: ΔA −2 · Exp +2 · ΔCash −302 · ΔNW −2 · STS −302
- The contribution itself isn't an expense.

**E-42 · Investment withdrawal**
Example: €500.00 back to Current.
- Postings: Investment −500.00 · Current +500.00
- Effects: ΔA — · ΔCash +500 · ΔNW — · Inc — (**gains aren't recognized as income on withdrawal**) · STS +500
- If the withdrawal exceeds the last recorded value, the user is warned to update the valuation. The next valuation corrects it (LR-12).

**E-43 · Change in a manually entered valuation**
Example: recorded €5,300.00, the user states €5,450.00.
- Postings: Investment +150.00 · VAL −150.00 (derived per LR-12)
- Effects: ΔA +150 · Inc — · Exp — · ΔCash — · ΔNW +150 (labelled "Valuation changes") · Budget — · STS —
- A decrease is symmetrical.
- If an earlier-dated contribution is later inserted, the valuation posting is recomputed so that the stated value still holds on its date.

**E-44 · Dividends and interest from investments**
- **Paid in cash:** Current +25.00 · Investment income −25.00 → Inc +25 · ΔCash +25 · STS +25
- **Reinvested:** Investment +25.00 · Investment income −25.00 → Inc +25 · ΔCash — · STS —
- **No double counting with a later valuation:** valuation deltas are computed from a balance that already includes the reinvested 25 (LR-12).

#### H. Savings and goals (details in §8)

**E-45 · Transfers to and from a dedicated goal account**
- Postings as in E-10. Goal progress +200 on a transfer in, −200 on a transfer out.
- STS −200 or +200 accordingly. Every other metric: —.

**E-46 · Virtual allocation created, changed or released**
Example: Current €3,000.00, €2,000.00 allocated to "House".
- Postings: **none** (LR-08).
- Effects: every ledger metric — · Goal House backed +2,000 · STS −2,000 (UGA)
- On a non-spendable account (Savings): STS —. That account is already outside ELF, so subtracting again would double count.
- Release: the exact reverse.
- An allocation above the unallocated balance is **rejected** (§8).

**E-47 · Spending from an account with allocations, below the allocated amount**
Example: Current €3,000.00, €2,000.00 allocated, then a €1,500.00 expense.
- Postings: Current −1,500.00 · Category +1,500.00
- Effects: Exp +1,500 · ΔNW −1,500 · ΔCash −1,500
- Goal: backed 2,000 → 1,500, with a **shortfall of 500** flagged.
- STS (AM-1/AM-2): before = 3,000 − 2,000 = 1,000. After = 1,500 − 2,000 = **−500**. So the STS change is **−1,500**: every euro spent from spendable money lowers STS by exactly one euro (P1).
- The goal shows the shortfall, and STS shows the overspending as "Shortfall €500".
- Before recording the expense, the app asks "Is this paid from your goal money?" (G-P4). Answering yes applies E-48 instead.

**E-48 · Using goal money for its purpose**
Example: €1,000.00 allocated to Vacation on Current, then a hotel paid for €1,000.00.
- One user action, one atomic operation: expense Current −1,000.00 · Travel +1,000.00, **plus** a release of €1,000.00 from Vacation.
- Effects: Exp +1,000 · ΔNW −1,000 · Goal: allocated 1,000 → 0, with "used 1,000" recorded · STS — (ELF −1,000, UGA −1,000)
- If the user records the expense without releasing the allocation, a shortfall of 1,000 appears (E-47) and the UI offers "release from Vacation".

#### I. Planned items (no postings)

**E-49 · Scheduled payment**
Example: rent €600.00 due on the 5th.
- Postings: none. Every ledger metric: —.
- Budget: shown in the "Scheduled" column of Rent (BR-07.5), never in Spent.
- STS −600 if due within [today, H] or overdue. — if due after H.
- Status: Planned.

**E-50 · Scheduled income**
Example: salary €2,000.00, marked as payday.
- Postings: none. Ledger metrics: —.
- **It never increases STS.** It determines the horizon H. It feeds the projection's "with income" line and the monthly plan.

**E-51 · Confirming or matching an occurrence**
- Creates or links the actual transaction (for example E-05 or E-27). The occurrence becomes Completed and leaves UCO, atomically (LR-03).
- Same amount: STS — (ELF and UCO fall equally).
- Different amount (planned 60.00, actual 71.40): STS −11.40. The occurrence completes with no remainder (BR-08.4).

**E-52 · Skipping an occurrence**
- Postings: none. The occurrence becomes Skipped, so UCO −600 and STS +600.

**E-53 · Overdue occurrence**
- Postings: none. It stays in UCO **regardless of the horizon** until it's completed or skipped.
- A notification fires (FR-20). Ledger metrics: —.

#### J. Imports

**E-54 · Imported transaction (new, unmatched)**
- Postings and effects as for the equivalent manual kind.
- Source = import, linked to its batch and row.
- Lifecycle: standard, plus batch undo.

**E-55 · Imported transaction matching a planned occurrence**
- Combines E-54 and E-51 in one atomic confirmation.
- **One** actual transaction. The occurrence becomes Completed.

**E-56 · Duplicate import**
- **Exact duplicate** (same fingerprint as an already imported row): no transaction is created. The row is recorded in the batch as "skipped: duplicate of #X". Effects: none.
- **Possible duplicate** (it matches an existing manual or derived posting):
  - If the user **links** them, no new postings are created. The existing transaction gains the import reference.
  - If the user **keeps both**, it's a normal E-54, and the decision is audited.

**E-57 · Import undo**
- Voids every transaction in the batch (E-39), atomically. Matched occurrences return to Planned or Overdue. Rows that were linked to existing transactions are unlinked; those transactions remain.
- Every effect reverts exactly to the pre-import state.
- Allocations are unaffected. If balances drop below allocations, shortfalls are flagged.
- Undo is blocked while any batch transaction is reconciled (BR-16.6).

#### K. Archiving and closing

**E-58 · Closing an account with a residual balance, then archiving it**
- The user transfers the remainder elsewhere (E-10/E-11), or posts an adjustment (E-36/E-37), until the balance is 0.
- First, every allocation on the account must be released or moved, and any goal link removed.
- Archiving itself: no postings, and history is retained.

**E-59 · Archiving or merging categories**
- **Archive:** no posting changes. The category is hidden from pickers and keeps its history.
- **Merge X → Y:** every X posting is reassigned to Y. Amounts are unchanged, so Income, Expenses and Net Worth are unchanged for every period. Only the category breakdown changes. The action is audited.
- Budgets of X in the current and future months are either added to Y (with confirmation) or removed. Past budgets of X stay as history.

**E-60 · Failed or partial operation**
Example: a transfer where the second posting fails to save, or an import confirmation interrupted after 300 of 800 rows.
- **Transaction level:** nothing is saved (LR-03). Balances are unchanged.
- **Batch level:** an import confirmation is all-or-nothing per batch. An interrupted confirmation leaves the batch in "not confirmed" with zero transactions, and it can be retried idempotently: retrying never creates duplicates.

### 5.7 Mandatory invariants: how each is enforced

| Mandatory invariant | Enforced by | Events demonstrating it |
|---|---|---|
| Internal transfers are not income or expenses | LR-06, §5.4 | E-10 to E-16 |
| A transfer affects both sides consistently | LR-01, LR-03 | E-10, E-15, E-60 |
| Card purchases are expenses at purchase | §5.4 Expense with a liability source | E-17 |
| Card repayments aren't counted again | §5.4 Transfer; card reserve excludes card payments from UCO | E-18, E-19, E-23 |
| Principal reduces liabilities; interest and fees are expenses | §5.4 Debt payment | E-27, E-28 |
| Refunds reduce the category, not income | LR-15, Refund kind | E-20, E-31 to E-34 |
| Planned items don't affect balances | LR-07, LR-09 | E-49 to E-53 |
| Allocations create no money | LR-08, backed-amount rule (§8) | E-46 to E-48 |
| Valuation isn't cash income | LR-05, LR-12 (VAL equity) | E-43, E-44 |
| Opening balances are consistent | LR-05 (OBE only) | E-01 to E-03 |
| Adjustments don't silently distort reports | LR-05, LR-13, labelled NW source | E-36, E-37 |
| Edits and reversals preserve integrity | LR-03, LR-10, LR-11 | E-38 to E-40, E-57 |
| Every transaction balances | LR-01, nightly integrity job (NFR-01) | All |
| Reports use consistent definitions | LR-16, §5.3 | Golden tests (§6) |

### 5.8 Exceptions, ambiguities and additional rules

1. **Voids rather than reversing entries (LR-11).**
   - Accounting systems traditionally post reversing entries. For non-experts, those create confusing "phantom" pairs in transaction lists.
   - The version history plus audit log keeps full traceability, and reconciliation locks protect closed periods.
   - Trade-off: no formal period closing. Users can change past months unless they're reconciled. I consider that acceptable for personal finance.
2. **Cashback and card rewards** (D-17, I-8, SC-4, approved):
   - Default: income, "Cashback & rewards".
   - Option: the user may record it as a negative expense in a spending category instead (GT-63).
   - Either way it's allowed on liability accounts (cashback credited to the card).
3. **Card instalment plans** (E-24): full expense at purchase (D-15). **Durable purchases financed by a loan** (E-26): expense by default, with a "Track as an asset" option for purchases of €5,000 or more, or in Vehicle and Property (D-16, BR-10.10).
4. **Overdrawn current accounts** stay negative assets (I-10, BR-10.12). Net worth is unaffected either way.
5. **Salary deductions:** recording net salary is the default. A gross salary with tax and social-security expense lines is possible as a split, but those lines then inflate Income and Expenses equally. Users should choose one approach consistently, and the UI warns when both appear.
6. **Payments to other people:** paying a friend is an **expense** (or lending, E-30), never a transfer. Transfers are only between the user's own accounts in the workspace.
7. **Investment returns:** cost basis isn't tracked. Realized gains aren't separated from unrealized ones, and all of them flow through VAL. Tax reporting isn't supported (a stated exclusion).
8. **Valuation vs adjustment asymmetry:** valuations are recomputed (LR-12) and adjustments aren't (LR-13). That's intentional:
   - A valuation states a *market value*, which is independent of transaction history.
   - An adjustment records a *discrepancy found at reconciliation time*. Recomputing it would erase evidence of later errors.
9. **Pending card transactions** (authorized but not yet booked) aren't modelled in the MVP. Imports should use booked transactions only, and the import mapping should warn if a status column shows pending rows.
10. **Refund larger than the original** is allowed with confirmation (BR-04.7). The category can go negative for the period.
11. **Clarifications to §2.3, binding:**
    - TIT is Cash class, non-spendable and system (E-15).
    - Card reserve = Σ max(0, owed) (§5.5).
12. **STS behaviour when spending eats into allocations** (E-47) follows AM-1 (S-3, approved): spending into goal money lowers STS euro for euro.

---

## 6. Golden test scenarios

### 6.1 Conventions

- All amounts are EUR. Workspace time zone: Europe/Sofia.
- **Flows** (Income, Expenses, Net Result, Cash Change) cover March 2026 unless stated otherwise.
- **Cash Change** (ΔCash) excludes opening balances (§2.3).
- **Safe to Spend (STS)** is evaluated on 31 Mar 2026 unless a different "today" is stated. With no payday income set up, H is today + 30 days, so 30 Apr 2026, and the window includes both ends. With payday income, the window ends the day before payday (option (c), §7.4). The protected reserve PR is €0 unless stated.
- Budget utilization is truncated to one decimal place (AM-3).
- Income rules use the non-working-day setting "on the date" unless stated (SC-1).
- **Net Worth identity check (NW-ID):** NW at the end of the period equals the opening NW plus Net Result plus the opening-balance, adjustment, valuation and conversion (CNV) effects.

**Baseline B0** (used unless a test says otherwise): user A's workspace, with accounts opened on 1 Mar 2026.

| Account | Opening balance | Spendable |
|---|---|---|
| Current | 1,000.00 | Yes |
| Cash wallet | 100.00 | Yes |
| Savings | 2,000.00 | No |

- March budgets: Food 250.00 (alert thresholds 80 % and 100 %), Shopping 150.00.
- No planned occurrences and no goal allocations.

**Baseline B1:** the same as B0, except Current opens at **3,000.00**.

Expected B0 figures: Assets 3,100.00 · Liabilities 0 · NW 3,100.00 · Income 0 · Expenses 0 · Net Result 0 · ΔCash 0 · STS 1,100.00. The STS figure is the eligible liquid funds (ELF) of 1,000 + 100, with nothing subtracted.

### 6.2 Opening balances and basic operations

**GT-01 · Opening balances (baseline)**
*Covers: E-01, LR-01, LR-05, FR-03*
- **Given / when:** B0 is created.
- **Then:**
  - Balances: Current 1,000.00 · Cash wallet 100.00 · Savings 2,000.00.
  - Assets 3,100.00 · Liabilities 0.00 · NW 3,100.00.
  - Income 0 · Expenses 0 · Net Result 0 · ΔCash 0.
  - Budgets: Food 0/250 (0.0 %) · Goals: none.
  - STS: 1,000 + 100 = **1,100.00**. Savings is excluded because it isn't spendable.
- **Why:** each opening-balance transaction posts to OBE (opening balance equity), so the transactions sum to 0. NW-ID: 0 + Net Result 0 + OBE effect 3,100 = 3,100 ✓. Opening balances are excluded from ΔCash.

**GT-02 · Opening balances on liabilities**
*Covers: E-02, FR-03, FR-10*
- **Given:** B0.
- **When:** on 1 Mar, add a Card with 300.00 owed (reserve on) and a Loan with 8,000.00 owed.
- **Then:**
  - Balances: Current 1,000 · Cash wallet 100 · Savings 2,000 · Card owed 300 · Loan owed 8,000.
  - Assets 3,100 · Liabilities 8,300 · NW **−5,200.00**.
  - Income, Expenses and ΔCash: 0.
  - STS = 1,100 − 300 (card reserve) = **800.00**. The loan isn't reserved; only its due instalments would count.
- **Why:** NW-ID: OBE effect 3,100 − 8,300 = −5,200 ✓.

**GT-03 · Income and expenses (bank and cash)**
*Covers: E-04, E-05, E-06*
- **Given:** B0.
- **When:**
  - 10 Mar: Salary 2,000.00 into Current.
  - 12 Mar: Food 45.60 from Current.
  - 14 Mar: Food 12.00 from the Cash wallet.
- **Then:**
  - Balances: Current 2,954.40 · Cash wallet 88.00 · Savings 2,000.
  - Assets 5,042.40 · Liabilities 0 · NW 5,042.40.
  - Income 2,000.00 · Expenses 57.60 · Net Result 1,942.40 · ΔCash +1,942.40.
  - Budget: Food 57.60/250 = 23.0 %.
  - STS = 2,954.40 + 88.00 = **3,042.40**.
- **Why:**
  - Current: 1,000 + 2,000 − 45.60.
  - NW-ID: 3,100 + 1,942.40 = 5,042.40 ✓.

**GT-04 · Split transaction**
*Covers: E-07, FR-06*
- **Given:** B0.
- **When:** 15 Mar: supermarket 120.00 from Current, split Food 80 / Household 30 / Personal care 10.
- **Then:**
  - Current 880.00 · Assets 2,980 · NW 2,980.
  - Expenses 120 (Food 80, Household 30, Personal care 10) · Net Result −120 · ΔCash −120.
  - Budget: Food 80/250 = 32.0 %.
  - STS **980.00**.
- **Why:** the category report sum (80 + 30 + 10 = 120) equals Expenses, as AC-15.1 requires.

**GT-05 · Percentage-split rounding**
*Covers: LR-17, BR-06.3, AM-5, §10*
- **When:**
  - (a) 100.00 split three ways equally.
  - (b) 10.00 split ⅓ / ⅔.
  - (c) 0.01 split 50 / 50.
- **Then:**
  - (a) 33.34 / 33.33 / 33.33.
  - (b) 3.33 / 6.67.
  - (c) The split is **rejected**.
- **Why:**
  - (a) Each raw share is 33.333…. Rounding down gives 99.99 in total, so 1 cent is left over. All lines have the same fractional part, so the tie goes to the first line.
  - (b) The raw shares are 3.333… and 6.666…. Rounding down gives 3.33 + 6.66 = 9.99. The leftover cent goes to the line with the larger fractional part (.666), giving 6.67.
  - (c) One line would be 0.00, which LR-02 forbids.
  - In every case, the lines sum exactly to the total.

### 6.3 Transfers

**GT-06 · Transfer to savings**
*Covers: E-10, LR-06*
- **Given:** B0.
- **When:** 12 Mar: Current → Savings 200.00.
- **Then:**
  - Current 800 · Savings 2,200 · Assets 3,100 · NW 3,100.
  - Income 0 · Expenses 0 · Net Result 0 · ΔCash 0 · budgets unaffected.
  - STS = 800 + 100 = **900.00**.
- **Why:** it's a transfer, so no category lines exist. Both accounts are Cash class, so ΔCash is 0.

**GT-07 · Transfer with a fee**
*Covers: E-12*
- **Given:** B0.
- **When:** Current → Savings 500.00, with a 1.50 fee.
- **Then:**
  - Current 498.50 · Savings 2,500 · Assets 3,098.50 · NW 3,098.50.
  - Expenses 1.50 (Bank fees) · Net Result −1.50 · ΔCash −1.50.
  - STS = 498.50 + 100 = **598.50**.
- **Why:** only the fee is an expense.

**GT-08 · ATM withdrawal, cash spending, cash deposit**
*Covers: E-13, E-06, E-14*
- **Given:** B0.
- **When:**
  - 10 Mar: ATM withdrawal of 100 with a 2 fee.
  - 11 Mar: Food 30 paid with cash.
  - 18 Mar: deposit 50 from the Cash wallet into Current.
- **Then:**
  - Current 948.00 · Cash wallet 120.00 · Savings 2,000 · Assets 3,068 · NW 3,068.
  - Expenses 32 (Bank fees 2, Food 30) · Net Result −32 · ΔCash −32.
  - Budget: Food 30/250 = 12.0 %.
  - STS = 948 + 120 = **1,068.00**.
- **Why:**
  - Current: 1,000 − 102 + 50 = 948.
  - Cash wallet: 100 + 100 − 30 − 50 = 120.
  - The withdrawal and the deposit aren't expenses.

**GT-09 · Both sides of a transfer imported**
*Covers: E-16, BR-16.5, §9*
- **Given:** B0.
- **When:**
  1. Import into Current: (12 Mar, −200.00, "Transfer to savings"). It's suggested as a transfer to Savings, and the user accepts.
  2. Import into Savings: (12 Mar, +200.00, "Transfer from current").
- **Then:**
  - Exactly **1** transaction exists, a transfer. The second import's row is classified as "already recorded: part of transfer #T", and 0 transactions are created.
  - Current 800 · Savings 2,200 · NW 3,100.
  - Income **0** · Expenses **0**.
  - STS 900.
- **Negative control:** the test also asserts that Income ≠ 200 and Expenses ≠ 200. A date difference of up to ±3 days still pairs the rows.

**GT-10 · Transfer in transit across month-end** (Should Have)
*Covers: E-15*
- **Given:** B0.
- **When:**
  - 31 Mar: 1,000 sent from Current into Transfers in Transit (TIT).
  - 2 Apr: TIT → Savings.
- **Then on 31 Mar:**
  - Current 0 · TIT 1,000 · Savings 2,000.
  - Cash Balance 3,100, because TIT counts as Cash class · NW 3,100.
  - March: Income 0 · Expenses 0 · ΔCash 0.
  - STS = 0 + 100 = **100.00**.
- **Then on 2 Apr:** TIT 0 · Savings 3,000 · April ΔCash 0 · NW 3,100.

### 6.4 Credit cards

For these tests, "B0 + Card" means a Card account opened on 1 Mar with 0.00 owed and the reserve on, unless stated otherwise.

**GT-11 · Card purchase and full repayment**
*Covers: E-17, E-18*
- **Given:** B0 + Card.
- **When:**
  - 5 Mar: card purchase, Shopping 80.00.
  - 25 Mar: repay 80.00 from Current.
- **Then:**
  - Current 920 · Card owed 0 · Assets 3,020 · Liabilities 0 · NW 3,020.
  - Expenses **80** (not 160) · Net Result −80 · ΔCash −80.
  - Budget: Shopping 80/150 = 53.3 %.
  - STS on 6 Mar: 1,100 − 80 = **1,020**. STS on 31 Mar: 1,020 − 0 = **1,020**, unchanged by the repayment.
- **Why:** the repayment is a transfer. ELF and the card reserve both fall by 80.

**GT-12 · Card refund and partial repayment**
*Covers: E-20, E-19*
- **Given:** B0 + Card.
- **When:**
  - 5 Mar: Shopping 80 on the card.
  - 8 Mar: refund 20 to the card.
  - 25 Mar: repay 50.
- **Then:**
  - Card owed 10 · Current 950 · Assets 3,050 · Liabilities 10 · NW 3,040.
  - Expenses 60 · Net Result −60 · ΔCash −50.
  - Budget: Shopping 60/150 = 40.0 %.
  - STS = 1,050 − 10 = **1,040**.
- **Why:** Net Result (−60) differs from ΔCash (−50) by the 10 still owed on the card. That's why §2.3 keeps them as two separate metrics.

**GT-13 · Card interest and annual fee**
*Covers: E-21*
- **Given:** B0 + Card opened with **500.00** owed.
- **When:** 28 Mar: interest 12.40 and annual fee 30.00, as one split transaction on the card.
- **Then:**
  - Card owed 542.40 · Assets 3,100 · Liabilities 542.40 · NW 2,557.60.
  - Expenses 42.40 · Net Result −42.40 · ΔCash 0.
  - STS = 1,100 − 542.40 = **557.60**.
- **Why:** NW-ID: OBE effect (3,100 − 500) − 42.40 = 2,557.60 ✓.

**GT-14 · Cash advance**
*Covers: E-22*
- **Given:** B0 + Card.
- **When:** 10 Mar: cash advance of 200 to the Cash wallet, with a 6 fee.
- **Then:**
  - Card owed 206 · Cash wallet 300 · Assets 3,300 · Liabilities 206 · NW 3,094.
  - Expenses 6 · Net Result −6 · ΔCash +200.
  - STS = (1,000 + 300) − 206 = **1,094**. That's 6 less than baseline: the borrowed cash doesn't increase STS.

**GT-15 · Card overpayment**
*Covers: E-23*
- **Given:** B0 + Card opened with 30.00 owed.
- **When:** 10 Mar: pay 50 from Current.
- **Then:**
  - Card owed **−20** (shown as a "credit balance of €20") · Current 950.
  - Assets 3,050 · Liabilities −20 · NW 3,070, unchanged.
  - Income 0 · Expenses 0 · ΔCash −50.
  - STS = 1,050 − max(0, −20) = **1,050**. Before the payment it was 1,100 − 30 = 1,070.
- **Why:** the 20 left on the card isn't spendable cash, and the card reserve is never negative.

**GT-16 · Card reserve on or off: no double counting**
*Covers: §7.5, E-18*
- **Given:** B0 + Card opened with 300 owed. A planned card repayment of 300 from Current is due 25 Mar. Today is 20 Mar, so H is 19 Apr.
- **Then:**
  - (A) Reserve **off**: the obligations to subtract (UCO) are the 300 planned payment, so STS = **800**.
  - (B) Reserve **on**: UCO is the 300 reserve, and the payment is excluded, so STS = **800**.
  - (C) Reserve on, plus a planned Netflix charge of 15 on the card due 1 Apr: UCO = 300 + 15, so STS = **785**. With the reserve off, the card-funded charge isn't counted, so STS = 800.
- **Assert:** STS is never 500. That would mean the same 300 had been subtracted twice.

**GT-17 · Card instalment plan**
*Covers: E-24, D-15*
- **Given:** B0. Today is 20 Mar, so H is 19 Apr.
- **When:**
  - 15 Mar: TV for 600 on a "TV plan" liability (Loan type).
  - A rule repays 6 × 100 from Current on the 15th, starting 15 Apr.
- **Then:**
  - TV plan owed 600 · Current 1,000 · Assets 3,100 · Liabilities 600 · NW 2,500.
  - Expenses 600 (Electronics) · Net Result −600 · ΔCash 0.
  - STS = 1,100 − 100 (the 15 Apr instalment) = **1,000**.
- **Contrast:** recorded on a reserved card instead, STS would be 500.

### 6.5 Loans and personal debts

**GT-18 · Loan instalment split**
*Covers: E-27*
- **Given:** B0 + Loan opened with 8,000 owed.
- **When:** 10 Mar: instalment of 400 (principal 320, interest 75, fee 5).
- **Then:**
  - Current 600 · Loan owed 7,680 · Assets 2,700 · Liabilities 7,680 · NW −4,980.
  - Expenses **80** · Net Result −80 · ΔCash −400.
  - STS **700**.
- **Why:** NW-ID: OBE effect (3,100 − 8,000) − 80 = −4,980 ✓. Only the interest and fee are expenses.

**GT-19 · Loan disbursement**
*Covers: E-25, AM-4*
- **Given:** B0.
- **When:** 10 Mar: open a Loan with 0 owed, then a transfer of 10,000 from the Loan into Current.
- **Then:**
  - Current 11,000 · Loan owed 10,000 · Assets 13,100 · Liabilities 10,000 · NW 3,100.
  - Income **0** · ΔCash +10,000.
  - STS **11,100**. The app suggests allocating the money.

**GT-20 · Planned instalment matched**
*Covers: E-51, P3*
- **Given:** B0 + Loan with 8,000 owed. A rule pays 400 (320 principal / 80 interest) from Current on the 25th.
- **Then:**
  - On 20 Mar (H = 19 Apr): STS = 1,100 − 400 = **700**.
  - On 25 Mar, after confirming the instalment: Current 600 · Loan 7,680 · Expenses 80. H moves to 24 Apr, and the next instalment (25 Apr) falls outside it, so STS = **700**, unchanged.

**GT-21 · Shared bill and repayment**
*Covers: E-30*
- **Given:** B0, plus a "Lent to friends" account (Other asset) at 0.
- **When:**
  - 14 Mar: dinner of 120 from Current, split Food 40 / Lent 80.
  - 22 Mar: friends repay 80 into Current.
- **Then after the dinner:** Current 880 · Lent 80 · NW 3,060 · Expenses 40 · Budget: Food 40/250 = 16.0 % · STS 980.
- **Then after the repayment:** Current 960 · Lent 0 · NW 3,060 · Expenses 40 · ΔCash −40 · STS **1,060**.

### 6.6 Refunds

**GT-22 · Full refund in the same month**
*Covers: E-31*
- **Given:** B0.
- **When:** 5 Mar: Shopping 59.99. 9 Mar: refund of 59.99, linked to the purchase.
- **Then:** Current 1,000 · Expenses 0 · Income **0** · Budget: Shopping 0/150 · NW 3,100 · STS 1,100.

**GT-23 · Partial refund**
*Covers: E-32*
- **Given:** B0.
- **When:** Clothing (a subcategory of Shopping) 45.00. Then a refund of 15.00.
- **Then:** Current 970 · Expenses 30 · Budget: Shopping 30/150 = 20.0 % · NW 3,070 · STS 1,070.

**GT-24 · Refund in a later month**
*Covers: E-33, B-2*
- **Given:** B0, with a Shopping budget of 150 in both March and April.
- **When:** 25 Mar: Shopping 100. 3 Apr: refund of 100.
- **Then:**
  - **March:** Expenses 100 · Budget: Shopping 100/150 = 66.6 % · NW at 31 Mar 3,000.
  - **April:** Expenses −100 · Shopping shows "net refund 100", 0.0 % · Net Result +100 · NW at 30 Apr 3,100.
  - March's figures are **unchanged** after the refund.
  - March and April combined: Expenses 0.
  - STS on 3 Apr: 1,100.

**GT-25 · Overspending, a refund, and alert thresholds**
*Covers: FR-07, AC-07.2*
- **Given:** B0 (Food budget 250, alerts at 80 % and 100 %).
- **When:** these Food transactions from Current:

| Date | Transaction | Food spent | Utilization | Alert |
|---|---|---|---|---|
| 10 Mar | Purchase 150 | 150 | 60 % | — |
| 15 Mar | Purchase 60 | 210 | 84 % | **80 % alert** |
| 18 Mar | Purchase 50 | 260 | 104 % | **100 % alert** |
| 19 Mar | Refund 30 | 230 | 92 % | — |
| 20 Mar | Purchase 25 | 255 | 102 % | — (already fired this month) |

- **Then:**
  - Food spent 255 · remaining **−5** · 102.0 % · **exactly 2 alerts**.
  - Current = 1,000 − 150 − 60 − 50 + 30 − 25 = 745.
  - Expenses 255 · NW 2,845 · STS **845**.

**GT-26 · Refund to a different account**
*Covers: E-34*
- **Given:** B0 + Card.
- **When:** 5 Mar: Shopping 80 on the card. 12 Mar: the refund of 80 arrives in Current.
- **Then:**
  - Card owed **80** · Current 1,080 · Assets 3,180 · Liabilities 80 · NW 3,100.
  - Expenses 0 · ΔCash +80.
  - STS = 1,180 − 80 = **1,100**.
- **Why:** the refund settles the expense, but the card debt remains until it's repaid.

**GT-27 · Income reversal**
*Covers: E-35*
- **Given:** B0.
- **When:** 10 Mar: Salary 2,000. 20 Mar: the employer reverses 150.
- **Then:** Current 2,850 · Income **1,850** · Expenses **0** · NW 4,950 · STS 2,950.

### 6.7 Planned versus actual, and recurring items

**GT-28 · Planned items don't affect actual figures**
*Covers: E-49, LR-07*
- **Given:** B0. A Rent rule of 600, monthly on the 25th, from Current. Rent budget 600. Today is 20 Mar.
- **Then:**
  - All balances as in B0 · NW 3,100 · Expenses 0.
  - Budget: Rent spent 0, scheduled 600.
  - STS = 1,100 − 600 = **500**. The 25 Apr occurrence is after H (19 Apr).

**GT-29 · Actual amount differs from the plan**
*Covers: E-51, BR-08.4*
- **Given:** B0. An Electricity rule, estimated 60, monthly on the 22nd, from Current.
- **Then:**
  - 20 Mar: STS = 1,100 − 60 = **1,040**.
  - 22 Mar, after confirming 71.40: Current 928.60 · Expenses 71.40 · the occurrence is Completed at 71.40.
  - STS on 22 Mar (H = 21 Apr, so 22 Apr is excluded) = 928.60 + 100 = **1,028.60**. That's a change of −11.40.

**GT-30 · Recurring generation: idempotent, month-end rules**
*Covers: BR-08.2, BR-08.6, BR-08.7*
- **Given:** a rule "monthly on day 31" from 31 Jan 2026, generated on 1 Jan 2026 with a 13-month window.
- **Then:**
  - 13 occurrences: 31 Jan, 28 Feb, 31 Mar, 30 Apr, 31 May, 30 Jun, 31 Jul, 31 Aug, 30 Sep, 31 Oct, 30 Nov, 31 Dec 2026, and 31 Jan 2027.
  - A second generation run leaves **13** occurrences.
  - February 2028 falls on 29 Feb.
- **Rule edit:** change the amount from 60 to 65 starting 1 Jun.
  - Occurrences completed in January–May keep 60.
  - A July occurrence the user edited individually to 70 keeps 70.
  - All other occurrences from June on show 65.

**GT-31 · Overdue items and skipping**
*Covers: E-52, E-53*
- **Given:** B0. Today is 20 Mar.
- **(a) One-off:** a planned car service of 600 due 5 Mar, unpaid.
  - It's Overdue and counted even though its date has passed: STS = **500**.
  - Skipping it gives STS **1,100**, with no ledger change.
- **(b) Monthly Rent of 600 on the 5th**, with March unpaid:
  - UCO = overdue 600 (5 Mar) + 600 (5 Apr, within H) = 1,200.
  - STS = **−100**, shown as "Shortfall €100".

**GT-32 · The payday window moves forward** (amended for option (c), AP-02/AP-17)
*Covers: §7.4 (H), E-04*
- **Given:** B0, with these rules:
  - Salary 2,000 on the 25th, **payday**.
  - Internet 30 on the 24th.
  - Phone 20 on the 25th.
  - Rent 600 on the 1st.
- **On 20 Mar:**
  - H = 25 Mar, and the window is 20–24 Mar.
  - UCO = Internet 30. Rent on 1 Apr is after H. Phone appears as "Due on payday: Phone 20".
  - STS **1,070**.
- **On 25 Mar, before the salary arrives** (Internet already paid on 24 Mar):
  - H = 25 Mar = today, and the salary is unmatched, so items due today count.
  - UCO = Phone 20.
  - STS = 1,070 − 20 = **1,050**.
- **On 25 Mar, after the salary and the phone bill are recorded and matched:**
  - ELF = 1,100 − 30 − 20 + 2,000 = 3,050.
  - H = 25 Apr, and the window is 25 Mar–24 Apr.
  - UCO = Rent 600 + Internet 30 = 630. "Due on payday (25 Apr): Phone 20" is shown.
  - STS = **2,420**.

**GT-33 · Payday income is late** (amended for option (c))
*Covers: §7.7*
- **Given:** the GT-32 rules. Today is 26 Mar. The salary hasn't arrived; Internet and Phone are paid.
- **Then:**
  - The overdue salary is ignored when setting H. The next one is due 25 Apr, so H = 25 Apr.
  - ELF = 1,050 · UCO = Rent 600 + Internet 30 = 630 (Phone on 25 Apr is on payday) · STS = **420**.
  - The user sees a warning: "Salary expected on 25 Mar has not arrived."
- **If the salary arrives on 27 Mar** and is matched: ELF 3,050, so STS **2,420**.

**GT-34 · Planned savings transfer**
*Covers: S-5*
- **Given:** B0. A one-off transfer of 300 from Current to Savings is planned for 28 Mar. Today is 20 Mar.
- **Then:**
  - 20 Mar: STS = 1,100 − 300 = **800**.
  - 28 Mar, after the transfer is done and matched: Current 700, so STS = 700 + 100 = **800**.
- **Option (S-5 off):** STS on 20 Mar is 1,100, and on 28 Mar it's 800.

### 6.8 Imports

**GT-35 · Identical rows and re-importing**
*Covers: E-56, BR-16.2–16.3*
- **Given:** B0.
- **When:**
  - File F1 into Current: (12 Mar, −2.50, "COFFEE BAR") twice, and (13 Mar, −45.00, "LIDL").
  - Import F1 again.
  - File F2: (13 Mar, −45.00, "LIDL") and (14 Mar, −10.00, "SHELL").
  - File F3: three rows of (12 Mar, −2.50, "COFFEE BAR").
- **Then:**

| Import | New | Exact duplicates skipped |
|---|---|---|
| F1 | 3 (the coffee rows get fingerprint ordinals 1 and 2) | 0 |
| F1 again | 0 | 3 |
| F2 | 1 | 1 |
| F3 | 1 (ordinal 3) | 2 (ordinals 1 and 2) |

  - Final: Expenses 2.50 × 3 + 45 + 10 = **62.50** · Current 937.50 · STS **1,037.50**.

**GT-36 · Possible duplicate of a manual entry**
*Covers: E-56, BR-16.4*
- **Given:** B0. A manual entry on 11 Mar: Food 45.60, payee "Lidl".
- **When:** an import row arrives: (12 Mar, −45.60, "LIDL SOFIA").
- **Then:**
  - The row is flagged as a possible duplicate: same account and amount, 1 day apart.
  - If the user **links** them: 1 transaction carrying the import reference · Expenses 45.60 · Current 954.40.
  - If the user **keeps both**: Expenses 91.20, and the decision is recorded in the audit trail.

**GT-37 · Import matches planned rent**
*Covers: E-55, AC-16.3*
- **Given:** B0. Rent rule: 600 monthly on the 25th. Today is 26 Mar, so H = 25 Apr.
- **When:** an import row arrives: (26 Mar, −600, "НАЕМ МАРТ"). A match is suggested: exact amount, 1 day after the due date, within the ±5-day window.
- **Accepted:**
  - 1 Rent expense · the occurrence is Completed · Current 400 · Expenses 600 · Rent spent 600.
  - STS = (400 + 100) − 600 (the 25 Apr rent) = **−100**.
- **Negative control, match rejected:**
  - UCO = overdue 600 (25 Mar) + 600 (25 Apr), so STS = **−700**, with the warning "Imported −600 may be the planned Rent."
  - The 600 difference between the two outcomes is exactly the double count that matching prevents.

**GT-38 · Undoing an import**
*Covers: E-57, BR-16.6*
- **Given:** B0. A payday Salary rule for 25 Mar.
- **When:** batch B1 on 26 Mar contains Salary +2,000 (matched to the occurrence), Food −45, Transport −30 and Food −25.
- **Then:**
  - Current 2,900 · Income 2,000 · Expenses 100 · STS = 3,000 − 0 = 3,000.
- **After undoing the batch:**
  - Current 1,000 · Income 0 · Expenses 0.
  - The salary occurrence is Overdue again · STS 1,100, with a late-salary warning.
- **Variant:** if Current was reconciled at 2,900 on 26 Mar before the undo, the undo is **blocked**, and the user sees the 4 locked transactions.

**GT-39 · Failed operations are all-or-nothing**
*Covers: E-60, LR-03*
- **(a)** A transfer of 200 from Current to Savings fails while saving its second posting.
  - Nothing is saved: Current 1,000 · Savings 2,000.
  - Retrying twice with the same idempotency key creates exactly **1** transfer.
- **(b)** Confirming an 800-row import is interrupted after 300 rows.
  - 0 transactions are saved, and the batch shows "not confirmed".
  - A retry saves exactly 800. A second retry changes nothing.

### 6.9 Reconciliation, edits and archiving

**GT-40 · Reconciliation with an adjustment**
*Covers: E-36, FR-18*
- **Given:** B0.
- **When:**
  - 10 Mar: Salary 2,000 into Current.
  - 12 Mar: Rent 600 from Current.
  - 15 Mar: Food 148.83 from Current.
  - Ledger balance of Current: 2,251.17. The statement on 31 Mar says 2,243.17.
  - The user posts an adjustment of −8.00 to ADJ (the balance-adjustment equity account).
- **Then:**
  - Current 2,243.17 · Assets 4,343.17 · NW 4,343.17.
  - Income 2,000 · Expenses 748.83 · Net Result 1,251.17 · ΔCash +1,243.17.
  - Budget: Food 59.5 %.
  - STS **2,343.17**.
  - All 4 transactions are reconciled and locked.
- **Why:** NW-ID: 3,100 + 1,251.17 − 8.00 = 4,343.17 ✓. The −8 appears as its own adjustment line and is excluded from Expenses.

**GT-41 · Untracked cash spending**
*Covers: E-37*
- **Given:** B0.
- **When:** 20 Mar: the user counts the wallet at 65 and chooses "I spent it".
- **Then:** Cash wallet 65 · Expenses 35 (Untracked spending) · NW 3,065 · STS 1,065.
- **Variant ("unexplained"):** Expenses 0, and the 35 appears as an adjustment. NW 3,065.

**GT-42 · Editing a reconciled transaction**
*Covers: E-40, LR-10*
- **Given:** the end state of GT-40.
- **When:** the user tries to change Food 148.83 to 158.83.
- **Then:**
  - The edit is **rejected** because the transaction is locked.
  - After an unlock (recorded in the audit trail) and the edit: Current 2,233.17 · Expenses 758.83.
  - The 31 Mar reconciliation is marked **broken**, with a difference of −10.00.

**GT-43 · Edit across a month boundary**
*Covers: E-38*
- **Given:** B0, with Food budgets of 250 in March and April.
- **When:** 31 Mar: Food 50. The user then changes its date to 1 Apr.
- **Then:**
  - March: Expenses 0 · Food 0.0 %.
  - April: Expenses 50 · Food 20.0 %.
  - One version-history entry is recorded.

**GT-44 · Void and restore a matched transaction**
*Covers: E-39*
- **Given:** B0. Rent is due 25 Mar and has been confirmed as transaction T.
- **When:** T is voided, then restored.
- **Then:**
  - After voiding: the occurrence is Planned (due today) · Current 1,000 · Expenses 0.
  - After restoring: the occurrence is Completed · Current 400 · Expenses 600. Every figure is identical to before the void.
- **Edge case:** if another transaction was matched to the occurrence in the meantime, T is restored without a link, and the user is warned.

**GT-45 · Archiving an account and merging categories**
*Covers: E-58, E-59*
- **(a)** An account "Old bank" (Cash class) opened 1 Mar with 12.34.
  - Archiving it is **rejected** because its balance isn't 0.
  - After transferring 12.34 to Current, archiving succeeds.
  - Current 1,012.34 · NW 3,112.34, unchanged by the archive. History is kept.
- **(b)** In March: Food 100 and Restaurants 50 (a separate category). Merge Restaurants into Food.
  - Food shows 150 · Expenses stay at **150**.

### 6.10 Investments

For these tests, "B0 + Investment" means an Investment account (non-spendable) opened on 1 Mar with 5,000.

**GT-46 · Contribution, valuation, and a back-dated insert**
*Covers: E-41, E-43, LR-12*
- **Given:** B0 + Investment.
- **When:**
  1. 5 Mar: contribution of 300 from Current, with a 2 broker fee.
  2. 31 Mar: the user states the value as 5,450.
  3. On 2 Apr, the user inserts a back-dated contribution of 100 dated 20 Mar.
- **Then after step 1:** Current 698 · Investment 5,300 · NW 8,098 · Expenses 2 · ΔCash −302.
- **Then after step 2:**
  - Investment 5,450 (valuation change VAL +150) · NW 8,248 · Income **0**.
  - NW-ID: 8,100 − 2 + 150 = 8,248 ✓.
- **Then after step 3:**
  - Current 598. The investment's balance before the valuation is now 5,400, so the valuation is **recalculated to VAL +50**, and the investment stays at 5,450.
  - NW 8,148. NW-ID: 8,100 − 2 + 50 = 8,148 ✓.
  - The recalculation is recorded in the audit trail.
  - STS on 2 Apr: **698**.

**GT-47 · Reinvested dividend with a valuation**
*Covers: E-44*
- **Given:** B0 + Investment.
- **When:** 15 Mar: a reinvested dividend of 25. 31 Mar: the user states the value as 5,100.
- **Then:**
  - Income 25 · valuation change VAL +75 (not 100) · NW 8,200 (not 8,225).
  - NW-ID: 8,100 + 25 + 75 = 8,200 ✓.

### 6.11 Goals and Safe to Spend

**GT-48 · Allocating money doesn't create money**
*Covers: E-46, §8*
- **Given:** B1 (Current 3,000).
- **When:**
  - Allocate 2,000 from Current to "House" (target 20,000).
  - Then allocate 1,500 from Savings to "Emergency".
- **Then:**
  - Balances are unchanged · Cash Balance 5,100 · NW **5,100** (not 7,100).
  - House 2,000/20,000 = 10.0 % · Emergency 1,500.
  - Unallocated: Current 1,000, Savings 500.
  - STS = 3,100 − 2,000 = **1,100**. The Emergency allocation sits in non-spendable Savings, so it doesn't change STS.

**GT-49 · Allocations can't exceed the money available**
*Covers: §8.3*
- **Given:** B0.
- **When:**
  - Allocate 800 from Current to "Car".
  - Try to allocate another 300 to "Vacation".
  - Allocate 200 to "Vacation" instead.
  - Separately, link Savings to the goal "House" as its dedicated account, then try to allocate from Savings, and try to make Savings spendable.
- **Then:**
  - The 300 is **rejected**, because only 200 is unallocated.
  - The 200 is accepted, leaving 0 unallocated · STS = 1,100 − 1,000 = **100**.
  - Allocating from the dedicated account is **rejected**.
  - Making the dedicated account spendable is **rejected**.
  - House progress = 2,000.

**GT-50 · Moving goal money out of savings**
*Covers: §8.4, AM-1*
- **Given:** B0. Savings 2,000 is fully allocated: Emergency 1,200 and Vacation 800, created in that order.
- **When:** transfer 500 from Savings to Current.
- **Then:**
  - Savings 1,500 · shortfall 500.
  - Backed amounts: Emergency 1,200 × 1,500 / 2,000 = 900; Vacation 800 × 0.75 = 600.
  - NW 3,100.
  - STS = 1,600 (ELF) − 500 (shortfall) = **1,100**, unchanged.
- **Follow-up:** the user moves 500 of the Emergency allocation to Current.
  - Savings allocations = 1,500 = its balance, so there's no shortfall. Current now holds a 500 allocation.
  - STS = 1,600 − 500 = **1,100**. Backed amounts: Emergency 1,200, Vacation 800.

**GT-51 · Spending into goal money on a spendable account**
*Covers: E-47 (amended), AM-1*
- **Given:** B1. 2,000 of Current is allocated to House.
- **When:** spend 1,500 on Furniture from Current.
- **Then:**
  - Current 1,500 · Expenses 1,500 · NW 3,600.
  - House backed 1,500, with a 500 shortfall.
  - STS goes from 1,100 to 1,600 − 2,000 = **−400** (a change of −1,500). The app shows "Shortfall €400; goals underfunded by €500".
- **The user releases 500 from House:** STS = 1,600 − 1,500 = **100**.

**GT-52 · Rounding of backed amounts, with ties**
*Covers: §8.4, §10*
- **Given:** Savings holds three allocations of 400.00 each (goals A, B, C, created in that order). Its balance falls to 1,000.01.
- **Then:** backed amounts A **333.34**, B **333.34**, C **333.33** (total 1,000.01) · shortfall 199.99.
- **Why:**
  - Each raw share is 1,000.01 × 400 / 1,200 = 333.33666…. Rounding each down gives 999.99 in total, so 2 cents are left over.
  - The fractional parts are equal, so the tie is broken by creation order: A and B get the extra cent.

**GT-53 · Spending goal money for its purpose**
*Covers: E-48*
- **Given:** B1. 1,000 of Current is allocated to Vacation. STS = 3,100 − 1,000 = 2,100.
- **When:** 10 Mar: a hotel for 1,000 recorded with "use goal money".
- **Then:**
  - Current 2,000 · Expenses 1,000 (Travel).
  - Vacation: allocated 0, used 1,000, status "Used".
  - STS = 2,100 − 0 = **2,100**, unchanged.
- **Without releasing the goal money:** STS 1,100, with a 1,000 shortfall warning and an offer to release.

**GT-54 · Planned payment linked to a goal** (Must, AP-03)
*Covers: §7.5, rule R5*
- **Given:** B0. 300 of Current is allocated to Insurance. An annual insurance payment of 360 from Current is due 10 Apr and **linked** to that goal. Today is 20 Mar, so H = 19 Apr.
- **Then:**
  - UGA (goal allocations subtracted) = 300.
  - UCO = max(0, 360 − 300) = 60.
  - STS = 1,100 − 60 − 300 = **740**.
  - Without the link, STS would be 440: the 300 would be subtracted twice.
- **10 Apr, paid with "use goal money":** Current 640 · STS = 740 − 0 − 0 = **740**.

**GT-55 · Overdrawn account and available credit**
*Covers: §7.7*
- **Given:** Current opens at **−150** (overdraft). Cash wallet 100 · Savings 2,000 · Card owed 0, with a credit limit of 1,000.
- **Then:**
  - ELF = −50 · STS = **−50**, shown as "Shortfall €50".
  - Assets 1,950 · NW 1,950.
  - Available credit of 1,000 is shown for information only, **not included** in STS.
  - Allocating from Current is rejected, because there's no positive balance to allocate.

**GT-56 · Irregular income with a protected reserve**
*Covers: §7.6*
- **Given:** B0 with a protected reserve PR of 500. No payday income.
  - An invoice of 1,500 (not payday income) is expected on 28 Mar.
  - Rent of 600 is due 1 Apr.
  - Today is 20 Mar, so H = 19 Apr.
- **Then:**
  - STS = 1,100 − 600 − 500 = **0**. The expected invoice is **not** added.
  - The cash-flow projection for 19 Apr: "with expected income" 2,000; "commitments only" 500.

**GT-57 · Money precision and alert exactness**
*Covers: LR-17, BR-07.7, AM-3*
- **(a)** Food 0.10 + 0.20 + 0.30 → Expenses exactly **0.60**.
- **(b)** Average monthly expenses for January–March, with a total of 100.00, displays as **33,33 €**. Stored totals are unaffected.
- **(c)** A limit of 300.00:
  - Spent 239.99 → displayed **79.9 %**, **no** 80 % alert. The integer check is 23,999 × 100 = 2,399,900, which is below 30,000 × 80 = 2,400,000.
  - Add 0.01 → spent 240.00 → **80.0 %**, and the alert fires.

**GT-58 · Month boundaries and time zone**
*Covers: A-1, A-2, A-8*
- **Given:** Europe/Sofia, which switches to summer time (UTC+3) on 29 Mar 2026.
- **Then:**
  - An entry made at 31 Mar 23:30 local time (20:30 UTC) defaults to the date **31 Mar**, so it counts in March.
  - An entry made at 1 Apr 00:30 local time (31 Mar 21:30 UTC) defaults to **1 Apr**, so it counts in April.
  - At 31 Mar 23:30 local time, an entry dated 1 Apr is rejected as a future date.
  - A CSV row with transaction date 31.03.2026 and booking date 02.04.2026, imported with a profile that uses the transaction date, counts in **March**.

**GT-59 · Isolation between two users**
*Covers: FR-02, AC-02.1–02.4*
- **Given:** user A has B0. User B has their own workspace with a Current account of 500.
- **When:** A adds Food 50.
- **Then:**
  - B's figures are unchanged: Assets 500, Expenses 0.
  - When B uses A's identifiers:
    - Reading A's transaction returns "not found".
    - Updating A's account returns "not found".
    - Creating a transaction with A's category is **rejected**.
  - B's search for "Lidl" returns 0 results.
  - B's export contains only B's account and opening balance.
  - A's NW: 3,050.

### 6.12 Combined scenarios

**GT-60 · September vs October comparison**
*Covers: FR-15, AC-15.3*
- **Given:**
  - September: Income 2,000; Expenses Rent 600, Utilities 140, Interest 52, Food 330, Transport 130, Entertainment 150, Shopping 98, totalling 1,500.
  - October: the §4 example (Expenses 1,427).
- **Then:**

| Line | September | October | Change | % |
|---|---|---|---|---|
| Income | 2,000 | 2,000 | 0 | 0.0 % |
| Expenses | 1,500 | 1,427 | −73 | −4.9 % |
| Net Result | 500 | 573 | +73 | +14.6 % |
| Utilities | 140 | 162 | +22 | +15.7 % |
| Interest | 52 | 50 | −2 | −3.8 % |
| Food | 330 | 390 | +60 | +18.2 % |
| Transport | 130 | 105 | −25 | −19.2 % |
| Entertainment | 150 | 60 | −90 | −60.0 % |
| Shopping | 98 | 60 | −38 | −38.8 % |

- **Why:** the category changes sum to 22 − 2 + 60 − 25 − 90 − 38 = −73, which equals the change in Expenses. Comparison percentages use ordinary rounding; only budget utilization is truncated.
- Balances aren't under test here.

**GT-61 · A full month (the §4 example) with end-of-month Safe to Spend**
*Covers: FR-07, FR-09, FR-12, NW-ID*
- **Given:** on 30 Sep: Current 500 · Savings 0 (non-spendable) · Card owed 0 (reserve on) · Loan owed 8,000. Rules:
  - Salary 2,000 on the 1st, payday.
  - Rent 600 on the 3rd.
  - Loan instalment 300 on the 5th (250 principal / 50 interest).
  - Utilities 150 (estimated) on the 15th.
- **When:** the October transactions from §4. After transferring 300 to Savings, the user allocates Emergency 200 and Vacation 100 there.
- **Then on 31 Oct:**
  - Current 583 · Savings 300 · Card owed 60 · Loan owed 7,750.
  - Assets 883 · Liabilities 7,810 · NW −6,927.
  - Income 2,000 · Expenses 1,427 · Net Result 573 · ΔCash +383 (883 − 500).
  - NW-ID: −7,500 + 573 = −6,927 ✓.
  - Budgets as in the §4 table · Emergency 200 and Vacation 100 fully backed.
  - **STS:** H = 1 Nov. No planned items fall in the window (31 Oct only), and the card reserve is 60, so UCO = 60. UGA = 0 (Savings isn't spendable and has no shortfall). STS = 583 − 60 = **523**.
- **Variant 61b (rent due on the 1st, the same day as the salary)** (amended for option (c), AP-02):
  - **31 Oct:** rent is due on payday, so it's outside the window. UCO = card reserve 60. "Due on payday: Rent 600" is shown. STS = **523**.
  - **1 Nov, before the salary is recorded:** H = today and the salary is unmatched, so rent counts. UCO = 600 + 60 = 660. STS = **−77**, shown as "Shortfall €77 until your salary arrives".
  - Note: 1 Nov 2026 is a Sunday. With the default non-working-day setting ("on the date"), the test is unaffected.

### 6.13 Tests added at approval (GT-62 to GT-71)

Baseline B0 as in §6.1. These tests cover SC-1, SC-2, SC-4, I-1, I-3, I-4, I-12 and CUR-1.

**GT-62 · Payday on a non-working day (SC-1)**
- **Given:**
  - ELF 1,100. No allocations and no cards.
  - Salary 2,000, monthly on day 31, payday, set to "previous working day".
  - Internet 30 on 29 Oct.
  - Phone 20 on 30 Oct.
- **Then:**
  - 31 Oct 2026 is a Saturday, so the salary is due Fri 30 Oct. The occurrence key stays (rule, 31 Oct), so regenerating it is idempotent.
  - **28 Oct:** H = 30 Oct. UCO = 30. STS **1,070**. "Due on payday (30 Oct): Phone 20" is shown.
  - Control case with the setting at "on the date": H = 31 Oct, UCO = 50, STS **1,050**.
  - **30 Oct, before the salary** (Internet already paid): STS = 1,070 − 20 = **1,050**.
  - After the salary is matched: H = 30 Nov, which is a Monday, so no shift.

**GT-63 · Cashback recorded two ways (SC-4)**
- **Given:** B0. On 15 Mar, 5.00 cashback arrives in Current.
- **Default:** Income "Cashback & rewards" 5.00. Expenses unchanged. Net Result +5.
- **Reclassified to Shopping:** Income 0. Expenses −5.00, so Shopping Spent is −5.00 and 155.00 of its 150 budget remains. Net Result +5.
- **Invariant:** Net Result, Net Worth (3,105), STS (1,105) and balances are identical either way. Only the split between Income and Expenses differs.
- **Variant, a statement credit on the card from GT-02:** the amount owed goes from 300 to 295. Income +5, Net Worth +5, and STS +5 because the card reserve is now 295.

**GT-64 · Payday income with a variable amount (SC-2)**
- **Given:** a Salary rule on the 25th into Current, marked payday, payer "ACME OOD", optional expected range 1,800–2,200.
- **Then:**
  - 24 Mar, +2,140 from ACME OOD: the match is suggested, because it's within the date window and the payer and account match. Once accepted, H = 25 Apr.
  - +2,600 from ACME OOD: still suggested, labelled "amount outside expected range".
  - +2,000 from another payer on 25 Mar: **not** suggested as the salary, and H doesn't move.

**GT-65 · Spending into goal money (I-1, AM-1 and G-P4)**
- **Given:** B0. On 5 Mar, goal "Holiday" gets a virtual allocation of 400 on Current. STS = 1,100 − 400 = **700**.
- **When:** on 10 Mar, a TV for 800 is paid from Current. The G-P4 prompt appears because Current holds allocations.
- **(a) The user answers "No":**
  - Current 200, ELF 300, UGA 400.
  - STS **−100**.
  - The goal shows "backed 200 of 400", and new allocations are blocked.
  - The old min-based formula would have shown +100; that's the defect AM-1 fixes.
- **(b) The user answers "Yes":** the expense and a release of 400 happen atomically. The released amount is min(expense, the goal's allocation on that account); the user can lower it. STS = **300**, and goal progress is 0.
- **Invariant:** Expenses (800), balances and Net Worth are identical in (a) and (b).

**GT-66 · Save for a bill (I-3, R5 and SC-3)**
- **(a) Goal money on a spendable account:**
  - **Given:** B0. Goal "Car insurance" with a 300 allocation on Current. A planned payment of 300 on 20 Apr from Current, linked to the goal. Evaluated on 31 Mar, with H = 30 Apr.
  - Without R5, both the bill and the goal would be deducted: STS 500. That's double counting.
  - With R5, the planned payment is covered by the goal: max(0, 300 − 300) = 0. STS = **800**.
  - 20 Apr, paid and matched: the release happens automatically. Current 700, UGA 0, STS **800**, so there's no jump.
- **(b) Goal money on Savings:**
  - 31 Mar: STS **1,100**.
  - 20 Apr, paid from Current: STS **800** (the accepted dip). The app prompts "Move €300 from Savings to Current?". After the transfer, STS is 1,100.
- **(c) Two linked payments, 200 on 10 Apr and 200 on 20 Apr, with 300 in the goal on Current:**
  - Coverage runs in due-date order: the first is covered fully, the second by 100.
  - UCO contribution is 0 + 100 = 100. STS = 1,100 − 300 − 100 = **700**, which equals the 1,100 less 400 of bills.

**GT-67 · Manual entry matched to a plan (I-4)**
- **Given:** B0. Rent 600, monthly on the 25th, from Current. On 20 Mar, STS **500**.
- **When:** on 24 Mar the user types "Rent 600". The app asks "This looks like your planned Rent (due 25 Mar). Link it?"
- **(a) Linked:** the occurrence is Completed. STS **500**, unchanged.
- **(b) Kept separate:** ELF 500, UCO 600, STS **−100**. The breakdown shows "Possible double count: Rent €600", with a Link action.

**GT-68 · Matching window for weekly rules (I-4)**
- **Given:** Groceries 50, every Monday from Current (2, 9, 16 … Mar 2026). W = min(5, floor((7 − 1) / 2)) = **3 days**.
- **Then:**
  - 50 on Thu 5 Mar: only the 2 Mar occurrence is suggested (3 days away; 9 Mar is 4 days away).
  - 50 on Fri 6 Mar: only 9 Mar is suggested.
  - For monthly rules: W = min(5, floor(27 / 2)) = 5.

**GT-69 · Card in the projection (I-12)**
- **Given:** B0 plus a Card with 300 owed (GT-02), reserved. STS = **800**.
- **(a) No repayment scheduled:** the projection starts at 1,100 − 300 = 800, and its lowest point is **800**.
- **(b) A repayment of 300 scheduled on 15 Apr:** the projection starts at 1,100, drops to 800 on 15 Apr, and its lowest point is **800**. STS stays 800, because a payment to a reserved card is not double-deducted.
- Before ER-4, case (a) showed 1,100, which contradicted STS.

**GT-70 · A USD workspace (CUR-1)**
*Covers: FR-23, BR-23.1, BR-23.3, BR-23.5, FR-22*
- **Given:** B0, but the workspace is created in **USD**.
- **Then:**
  - Every figure equals the EUR baseline: Assets 3,100.00 · NW 3,100.00 · STS 1,100.00.
  - The whole golden suite gives identical numbers when run in a USD workspace.
  - Display in the Bulgarian UI: "1 100,00 $" (OD-18). No euro sign appears anywhere.
  - Creating an account in EUR inside this workspace is rejected.

**GT-71 · Currency lock and foreign rows in imports (CUR-1)**
*Covers: BR-23.2, BR-23.4*
- **Given:** an EUR workspace with B0.
- **Then:**
  - Changing the workspace currency to USD is rejected, because transactions exist. A new, empty workspace could still choose freely.
  - An import file with a currency column holding (12 Mar, −45.00, EUR), (13 Mar, −20.00, USD) and (14 Dec 2025, −50.00, BGN): row 1 is imported, rows 2 and 3 are rejected with "Currency USD/BGN isn't supported in this workspace". Expenses 45.00 · Current 955.00.
  - The same file without a currency column: the preview states "All amounts are treated as EUR", and the user must confirm.

---

## 7. Safe to Spend specification

### 7.1 The question it answers

> "How much can I spend today on things I haven't planned for, without failing to cover what I've already committed to before my next payday, and without touching money I've set aside?"

**Decisions it supports:**
- Can I afford this purchase now?
- Should I postpone discretionary spending?
- Am I on track to reach payday?
- Have I eaten into my savings goals?

**Decisions it does not answer:**
- Long-term affordability (that's the cash-flow projection and the goals).
- Investment decisions.
- Credit decisions.

The product presents Safe to Spend as information, not financial advice; the wording is a legal question, covered in §11.

### 7.2 What counts and what doesn't

| Money or obligation | How Safe to Spend treats it |
|---|---|
| Current liquid funds | **Included** (ELF), for spendable Cash accounts only. Negative balances are included too. |
| Savings and investment balances | **Excluded**. Non-spendable accounts are outside ELF. |
| Upcoming committed expenses | **Subtracted** when due within the window (UCO). |
| Expected income | **Never added**. It only sets the end of the window (if it's marked as payday). |
| Emergency reserve | **Subtracted** as the protected reserve PR. |
| Virtual savings allocations | **Subtracted** when they sit on spendable money, or when they're unfunded (UGA). |
| Credit limits and available borrowing | **Never included**. Shown for information only. |
| Overdue payments | **Always subtracted**, whatever the horizon. |
| Uncertain future transactions (estimates) | Planned outflows count at their estimated amount. Uncertain income is ignored. |
| Card debt already incurred | **Subtracted** (card reserve, default on). |

### 7.3 Candidate formulas

| # | Formula | Strengths | Weaknesses | Verdict |
|---|---|---|---|---|
| F1 | Sum of all balances | Trivial | Ignores bills, cards and goals. Forbidden by C-5. | ❌ Rejected |
| F2 | ELF − obligations to the end of the month − allocations | Simple and calendar-aligned | Wrong for anyone paid mid-month: on the 24th, with salary on the 25th, it subtracts bills that the salary will cover. | Alternative |
| **F3** | **ELF − UCO − PR − UGA, with the window running to the next payday (30-day fallback)** | Conservative, matches how people experience pay cycles, never relies on money that hasn't arrived | Can dip sharply when rent falls just after payday; needs a payday marker on income | ✅ **Approved (S-1)** |
| F4 | F3 plus payday income within a month-end horizon | Smoother; shows the month as a whole | Counts money that hasn't arrived. A late or reduced salary makes it wrong exactly when it matters. | Alternative, opt-in later |
| F5 | Remaining flexible-category budgets, capped by F3 | Ties spending to the plan | Depends on budgets being set up and kept current; confusing without budgets | "Within plan" sub-figure later (Could) |

### 7.4 Approved formula (F3, including AM-1 and option (c))

```
STS(today) = ELF − UCO − PR − UGA
```

**Term definitions:**

| Term | Precise definition |
|---|---|
| S | The set of spendable accounts: Cash class, spendable flag on, not dedicated to a goal, not archived. |
| N | Non-spendable Cash accounts that hold allocations. |
| **ELF** | Σ over a in S of Bal(a, today). Only actual, non-voided transactions dated on or before today. Negative balances included. |
| **H** | The due date of the earliest *Planned* occurrence of an income rule marked **payday**, with due date on or after today, capped at today + 45 days. If there's none, H = today + 30. Overdue payday income is ignored. The due date includes the non-working-day setting (SC-1). |
| **Window W(today)** | **Payday case:** [today, H), so payday itself is excluded. **Exception:** when H = today and that payday occurrence is still unmatched, the window is [today, today], so items due today count. **Fallback case** (no payday within 45 days): [today, today + 30], both ends included. |
| **UCO** | The sum of the four components listed after this table. |
| **PR** | The protected reserve: a user-set amount ≥ 0, default 0. |
| **UGA** | Σ over a in S of Alloc(a), plus Σ over a in N of Shortfall(a), where Shortfall(a) = max(0, Alloc(a) − max(0, Bal(a))). For a spendable account this covers the earmarked money still inside ELF plus any part already spent; for a savings account, only the part that has left it. |

**The four components of UCO:**
- (1) Planned outflows from accounts in S, due within the window W, that haven't been matched to an actual transaction.
- (2) **All** overdue outflows from accounts in S that haven't been matched.
- (3) The **card reserve**: Σ max(0, amount owed) over cards with the reserve on.
- (4) Planned expenses charged to reserved cards, due within W or overdue.
- Items due on payday that fall outside W are listed on an information line, "Due on payday: …", and are not subtracted.

**What counts as a "planned outflow":**
- **Counted:** expenses, debt payments to liabilities that aren't reserved (loans, instalment plans), transfers to Investment or Other-asset accounts, and transfers into N or other non-spendable accounts (subject to S-5).
- **Not counted:** transfers between two accounts in S, and payments to reserved cards (the card reserve already covers them).

### 7.5 Rules that prevent subtracting anything twice

| Rule | Overlap it prevents |
|---|---|
| R1 | Card reserve vs a planned card payment: payments to reserved cards are excluded from UCO. |
| R2 | A planned item vs the actual transaction: a matched occurrence is Completed and leaves UCO, while the actual sits in ELF. Unmatched imports that look like a planned item raise a warning (GT-37). |
| R3 | Allocations on non-spendable accounts: that money is already outside ELF, so only its shortfall counts. |
| R4 | A dedicated goal account: it's never in S and never holds allocations, so it's excluded once. |
| R5 | A planned item linked to a goal (**Must**, AP-03): its UCO amount is max(0, amount − the goal's backed allocation not already used by earlier linked items, applied in due-date order). A planned payment links to one goal; a goal can have many linked payments. Confirming a linked payment offers "use goal money". If the goal money is on a non-spendable account and the bill is paid from a spendable one, the temporary dip until the money is moved is accepted, with a "Move €X from Savings now?" prompt. Presented to users as a "Save for a bill" goal (SC-3). |
| R6 | A planned transfer within S: excluded, because it's net zero. |
| R7 | Budgets aren't a term in the formula, so a budget and a planned item for the same bill can't both be subtracted. |
| R8 | Protected reserve vs money in savings: the UI explains that if the emergency fund is kept in a non-spendable account, PR should normally be 0. This is a usage rule, not something the system enforces. |

### 7.6 How expected income is treated

- Expected income is **never added** to Safe to Spend. It only determines H, and only when it's marked as payday.
- **Payday marker (SC-2, replaces the former "reliable" flag):**
  - Only a recurring income rule can be marked as payday (for example salary or a pension). The user sets it; onboarding asks "When do you usually get paid?" (Must).
  - It's allowed on fixed-amount **and** variable-amount rules, because only the date is used. A payday rule requires a payer and may hold an optional expected amount range.
  - Matching for payday income uses date window, account and payer; the amount isn't required (§9.5, M-3/M-4, GT-64).
  - **Should:** the UI suggests the marker after 2 consecutive on-time matches, and suggests removing it after 2 late arrivals out of the last 3. It's never set or removed automatically.
  - Each income rule has a non-working-day setting: "on the date" (default), "previous working day" or "next working day" (SC-1, Should). Weekends only in the MVP; public holidays later (OD-09).
- For irregular income, H is today + 30 days, and the user is encouraged to set a protected reserve. The "with expected income" line in the cash-flow projection is where expected income appears.
- Formula F4 (an opt-in mode that counts income before it arrives) would be a separate, clearly labelled mode, and only after the MVP (Decision S-1).

### 7.7 Behaviour in specific situations

| Situation | Behaviour |
|---|---|
| Result is negative | Shown as "Shortfall €X", not clamped to 0, with the three largest contributing items listed (GT-31b, GT-51, GT-55). An in-app alert follows. |
| No upcoming obligations | STS = ELF − PR − UGA. |
| Next income date unknown | H = today + 30 days. The label reads "for the next 30 days". |
| Savings goals overlap account balances | Per R3 and R4, and GT-48. |
| Planned payment already imported and confirmed | It's Completed and excluded (R2). If it wasn't matched, it may be double counted, so a warning appears. |
| Account overdrawn | The negative balance reduces ELF (GT-55). |
| Card has available credit | Ignored, and shown separately for information. |
| Irregular income | 30-day horizon, no income added, protected reserve recommended (GT-56). |
| Payday income overdue | Ignored when setting H, so the window extends to the next one (GT-33). A warning appears. |
| Planned item due today | Included. |
| Planned item due on payday | Excluded until payday, shown as "Due on payday". On payday it's included while the salary is unmatched (GT-32, GT-61b). |
| Overdue item older than 30 days | Still counted. A monthly "Still unpaid?" prompt asks the user to resolve it (ER-5). |
| Possible double count | An unmatched planned item and a similar actual transaction (same account, amount ±10%, within the matching window) are shown as "Possible double count", with a Link action (GT-67). |
| Estimated amount (for example a utility bill) | Its estimate is used until the bill is matched. |
| Spendable account archived | Not possible while its balance isn't 0 (E-58). |

### 7.8 Worked examples (in addition to the golden tests)

**Example 1: ordinary case, mid-cycle**
- Current 1,450 and Cash 50, both spendable. Savings 4,000, not spendable.
- Salary due on the 25th, payday. Today is the 18th, so the window is 18th–24th.
- Planned: phone 25 (20th), electricity estimate 70 (22nd), loan instalment 300 (25th, on payday).
- Card owed 120, reserved. 200 of Current is allocated to "Gifts". PR 0.
- Calculation (amended for option (c)):
  - ELF = 1,450 + 50 = 1,500.
  - UCO = 25 + 70 + 120 = 215. The instalment is shown as "Due on payday: Loan instalment 300".
  - UGA = 200.
  - STS = 1,500 − 215 − 0 − 200 = **1,085**.
  - Over 7 days (18th–24th), that's **155.00 per day**.
  - On the 25th, if the salary hasn't been recorded yet, the instalment counts: STS = **785**.
  - Per-day amounts are rounded down to the cent (ER-1). Example: 785 / 8 = 98.125 → **98.12**.

**Example 2: an obligation falling just after payday**
- The same as Example 1, but rent of 700 is due on the 26th, the day after the salary.
- Rent is outside H, so STS is still **785**.
- On the 25th, once the salary of 2,100 arrives and the instalment is paid, the horizon moves to the next salary, so rent and the next month's bills enter UCO.
- This is correct: F3 assumes the salary covers obligations from payday onwards. Under option (c), items due *on* payday are treated the same way, unless the salary is late on the day itself (S-4, AP-02).

**Example 3: F3 vs F4 on the same day**
- ELF 600 · salary 2,000 due in 3 days · rent 700 due in 5 days · today is the 20th.
- F3: H = 23rd, rent is outside it, so STS = **600**.
- F4 (horizon to the end of the month, income included): 600 + 2,000 − 700 = **1,900**.
- If the salary is delayed by a week, F4 has allowed spending of 1,300 that isn't there yet. That's the main reason for recommending F3.

**Example 4: negative result**
- ELF 300 · overdue electricity 80 · instalment 300 due before H · PR 100 · UGA 0.
- STS = 300 − 380 − 100 = **−180**: "Shortfall €180".
- Contributors listed: Instalment 300, Reserve 100, Electricity (overdue) 80.

### 7.9 Properties the tests verify

| # | Property | Golden tests |
|---|---|---|
| P1 | An expense of X from a spendable account lowers STS by exactly X. | GT-03, GT-51 |
| P2 | A transfer between spendable accounts never changes STS. | GT-08 (deposit) |
| P3 | Matching a planned item at its planned amount never changes STS. | GT-20, GT-34 |
| P4 | With the card reserve on, a card purchase of X lowers STS by X, and repaying the card doesn't change STS. | GT-11 |
| P5 | Allocating X from a spendable account lowers STS by X. Allocating from a non-spendable account doesn't change it. Moving goal money between the user's own Cash accounts doesn't change it. | GT-48, GT-50 |
| P6 | Expected income never raises STS before it arrives. | GT-56 |
| P7 | Overdue unmatched items are always subtracted. | GT-31 |
| P8 | Every term shown in the breakdown can be traced item by item, and the items sum to the term. | AC-12.2 |

### 7.10 Display requirements

- **Main figure:** "Safe to spend until 24 Mar" (the last day before payday), or "…in the next 30 days" when there's no payday income. The window is always shown with the figure (I-13).
- **Optional figure:** an amount per day = STS ÷ number of days in the window, rounded down to the cent (ER-1). The payday case has H − today days (minimum 1); the fallback case has 31.
- **Breakdown:** a tap shows each of the four terms with the items behind them, plus the information-only lines: available credit (not included), expected income (not included), "Due on payday" items, and "Possible double count" pairs.
- **Explainer (SC-5):** "This is not your bank balance", with a link to the breakdown. Budget-remainder wording must never reuse the Safe to Spend term (D-2).
- **Freshness (I-13):** "Last bank import: N days ago".
- **Negative values (I-13):** worded as "You need €X more to cover what's planned" or "Shortfall €X until your salary arrives", not just a red minus figure.
- **Warnings:** an unmatched possible duplicate, late payday income, an allocation shortfall, a negative result.

### 7.11 Limitations

- It relies on users setting up recurring rules. Without them, STS overstates what's safe. Onboarding should prompt for rent, loans and the main bills.
- Estimated bills can be wrong.
- Commitments that aren't in the app (a friend expecting repayment, an annual tax bill) aren't known.
- Only one horizon is used. A large bill just after the horizon isn't shown here; it's visible in the projection and the calendar.
- With the card reserve on, people who carry a card balance from month to month will see a low figure. They can turn the reserve off per card.

### 7.12 Approved decisions

| ID | Decision | Approved position |
|---|---|---|
| S-1 | The formula | F3 (the "until next payday" window, described above). F4 later as an opt-in mode. |
| S-2 | Window rules | Next payday, with a 45-day cap and a 30-day fallback. |
| S-3 | Treatment of allocation shortfalls | AM-1 (full allocation on spendable accounts, plus shortfalls on non-spendable ones), with the G-P4 prompt (AP-01). |
| S-4 | Whether payday is in the window | Option (c): excluded, except on payday itself while the salary is unmatched (AP-02). |
| S-5 | Do planned transfers to savings count as commitments? | Yes by default, with a workspace setting to turn it off. |
| S-6 | Default card reserve | On, adjustable per card. |
| S-7 | Default protected reserve | €0, with an onboarding prompt suggesting one month of fixed costs. |
| S-8 | Planned payments linked to goals (R5) | **Must** (AP-03), presented as "Save for a bill" (SC-3). |

### 7.13 Non-goals (SC-6, approved)

Practices seen in competing apps that this product deliberately does **not** adopt (evidence in Appendix B):

- Adding expected income into Safe to Spend. It breaks the rule that planned ≠ actual.
- Extrapolating past spending into the figure.
- A toggle to include or exclude card payments. In the ledger a card payment is always a transfer.
- Moving refunds back to the original purchase date. It rewrites closed months.
- Counting unused credit limit as spendable money.
- Opaque "learning period" figures the user can't trace item by item (P8).

---

## 8. Savings and allocation rules

### 8.1 Terms

| Term | Definition |
|---|---|
| Goal | Name, optional target T, optional target date, optional planned monthly contribution c, funding method, status. |
| Funding method | Either **Dedicated** (whole accounts) or **Virtual** (allocations). It's fixed per goal; changing it is a guided conversion (§8.9). |
| Alloc(a, g) | The amount of goal g allocated on account a, ≥ 0, in integer cents. |
| Alloc(a) | Σ over g of Alloc(a, g). |
| Unallocated(a) | max(0, Bal(a)) − Alloc(a). Can be negative when there's a shortfall. |
| Shortfall(a) | max(0, Alloc(a) − max(0, Bal(a))). |
| Backed(a, g) | Alloc(a, g) when Shortfall(a) = 0. Otherwise, the account's positive balance shared out in proportion to each allocation, using the largest-remainder method, with ties broken by goal creation order (GT-52). |
| Progress(g) | Dedicated: Σ max(0, Bal) over the linked accounts. Virtual: Σ over a of Backed(a, g). |
| Used(g) | The cumulative amount released through "use goal money". Shown in history. |

### 8.2 Goals linked to whole accounts (Dedicated)

- G-D1: The **whole** balance of each linked account counts toward the goal. Linking only part of an account is done with virtual allocations instead. That keeps the two methods apart.
- G-D2: An account can be dedicated to at most one goal. A goal can have several dedicated accounts.
- G-D3: Linking an account sets it to non-spendable and blocks allocations on it. If allocations already exist, they must be released or moved first.
- G-D4: Linking is only allowed for Cash-class accounts in the MVP. Investment accounts come later, because their value fluctuates.
- G-D5: Spending from or moving money out of a dedicated account lowers progress immediately. There's no shortfall concept, and STS doesn't change (R4).
- G-D6: Unlinking returns the account to the user's chosen spendable setting, and the goal's progress drops to 0 unless another account is linked.

### 8.3 Virtual allocations

- G-V1: Allocations are allowed only on Cash-class accounts that aren't dedicated to a goal and aren't archived. Spendable and non-spendable accounts are both allowed.
- G-V2: **Create or increase:** the new Alloc(a) must be ≤ max(0, Bal(a, today)). Otherwise it's rejected with "only €X unallocated". It's also rejected whenever the account already has a shortfall.
- G-V3: **Decrease or release** is always allowed, including during a shortfall. It can't go below 0.
- G-V4: **Move:**
  - Between goals on the same account, or between accounts for the same goal, as one atomic operation.
  - The destination must satisfy G-V2. The source decreases by the same amount.
- G-V5: Several goals can draw from the same account, and one goal can draw from several accounts.
- G-V6: Every create, increase, decrease, release and move is recorded with a timestamp, the user and a reason. That record gives allocation history and progress over time.
- G-V7: Allocations never create postings (LR-08), and they're dated "as of now". Back-dating allocations isn't supported in the MVP.

### 8.4 Shortfalls

- G-S1: A shortfall arises only when money leaves the account (spending, transfers out, edits, voids, undoing an import). Allocations themselves can't cause one (G-V2).
- G-S2: The system **doesn't release allocations automatically**. Only the user decides to give up goal money.
- G-S3: While there's a shortfall:
  - Goal progress shows the backed amount, with a "€X short" badge.
  - An in-app alert fires once when the shortfall appears.
  - STS reflects it (AM-1).
- G-S4: Money flowing back into the account reduces the shortfall first, and the backed amounts recover in proportion.
- G-S5: Proportional sharing (rather than a user-set priority order) is the MVP default. Priority order is Decision G-2.

### 8.5 Transfers

- G-T1: Allocations don't follow money. A transfer out of an account with allocations can create a shortfall.
- G-T2: When a transfer would create a shortfall, the entry form offers "Also move €X of allocations", pre-selecting the allocations in proportion. Accepting makes it one atomic operation (GT-50).
- G-T3: Moving money between Cash accounts doesn't change STS when the allocations move with it, or when the source is non-spendable (P5).

### 8.6 Spending

- G-P1: Ordinary spending doesn't touch allocations (and can cause a shortfall).
- G-P2: "Use goal money" records the expense and releases the same amount from the chosen goal, atomically (E-48).
- G-P3: Spending recorded first can be connected later: "release €X from goal Y to cover this".
- G-P4 (AP-01): whenever an expense is recorded against an account that holds allocations, the app asks "Is this paid from your goal money? [Goal A €X] [Goal B €Y] [No]". Choosing a goal applies "use goal money" for min(expense, that goal's allocation on the account); the user can lower the amount (GT-65).

### 8.7 How allocations affect Safe to Spend

- Allocations on spendable accounts: subtracted in full (AM-1).
- Allocations on non-spendable accounts: only their shortfall is subtracted.
- Dedicated goal accounts: excluded from ELF. Nothing is subtracted.
- Planned payments linked to a goal: R5 (**Must**), shown to users as "Save for a bill" (SC-3, GT-66).

### 8.8 Projections and schedule

All amounts are in integer cents. Contributions are assumed to happen at each month-end, **starting with the current month**.

| Quantity | Formula |
|---|---|
| Remaining | R = max(0, T − Progress) |
| Months needed | n = ceil(R / c), when c > 0 |
| Estimated completion | The end of month (current month + n − 1). If R = 0, the goal is "Reached". |
| Month-ends left | m = the number of month-ends from the current month through the target date's month |
| Required monthly amount | ceil to the cent of R / m |
| Behind schedule | c < required monthly amount. Checked monthly, with one alert per month. |

**Example:** House goal with T 20,000 and progress 2,000, c = 1,000, today 15 Mar 2026, target date 31 Dec 2027.
- R = 18,000. n = 18, so the estimated completion is **31 Aug 2027** (March 2026 is contribution 1, August 2027 is contribution 18).
- m = 10 month-ends left in 2026 + 12 in 2027 = 22.
- Required monthly = 18,000 / 22 = 818.18…, rounded up to **818.19**.
- c (1,000) is above that, so the goal is **on track**.

### 8.9 Goal lifecycle

- **Active → Reached** when progress ≥ the target. The allocations remain.
- **Reached → Used**, through "use goal money".
- **Archived:** all allocations must be released first, and dedicated accounts are unlinked.
- **Converting from Dedicated to Virtual:** the guided flow unlinks the account and creates an allocation equal to its current balance, so the account then shows as fully allocated.
- **Converting from Virtual to Dedicated:** allowed only if the target account holds no allocations for other goals.
- Goals with no target track progress only. There's no projection or "behind schedule" status.

### 8.10 Worked examples: the same money is never counted twice

**Example A (a virtual goal on a current account)**
- Current 3,000, with 2,000 allocated to House.
- Cash Balance 3,000 · NW 3,000 · House 2,000 · unallocated 1,000.
- Goals plus unallocated money = 2,000 + 1,000 = 3,000, which equals the balance. No money is created.

**Example B (two goals on one savings account, then a withdrawal)**
- Savings 1,000, with Emergency 600 and Vacation 400.
- The user withdraws 250 to Current, and the allocations stay on Savings.
- Shortfall 250. Backed amounts: Emergency 450, Vacation 300, totalling 750, which equals the Savings balance.
- STS: ELF rises by 250 and UGA rises by 250, so no change. The withdrawn money doesn't become spendable.

**Example C (a dedicated goal account)**
- Savings 5,000 is dedicated to House. Current is 1,000.
- Any attempt to also allocate the Savings money to "Car" is rejected (G-D3).
- NW 6,000 · House progress 5,000 · STS 1,000.

### 8.11 Acceptance criteria

- **AC-09.4:** For every account, the sum of its goals' backed amounts never exceeds max(0, balance) (an integrity check).
- **AC-09.5:** Total goal progress never exceeds the sum of positive balances on Cash-class accounts.
- **AC-09.6:** No goal operation changes any ledger figure (Assets, Liabilities, NW, Income, Expenses, ΔCash).
- **AC-09.7:** The backed amounts on an account in shortfall sum exactly to its positive balance, using the largest-remainder method (GT-52).
- **AC-09.8:** "Use goal money" is atomic. If either the expense or the release fails, neither is saved.
- **AC-09.9:** The projection formulas reproduce the §8.8 example exactly.

### 8.12 Approved decisions

| ID | Decision | Approved position |
|---|---|---|
| G-1 | A goal uses one funding method only | Yes (simplest, and it rules out double counting) |
| G-2 | How a shortfall is shared between goals | Proportionally in the MVP. A user-set priority order later. |
| G-3 | Automatic monthly allocation of the planned contribution | Later. In the MVP, the user allocates manually. |
| G-4 | Allocations or dedicated links on Investment accounts | Later |
| G-5 | "Behind schedule" rule | c below the required monthly amount, checked monthly |

---

## 9. Transaction lifecycle and conceptual data model

*This is a conceptual model. It is not a database schema; tables, types and constraints are designed in Stage 2.*

### 9.1 Ownership principle
- Every financial object belongs to **exactly one workspace**.
- A reference between objects is valid only inside the same workspace. This has to be enforced at two independent layers: application and data (FR-02). How to do that is decided in Stage 2.
- For the MVP, a workspace has one owner. A Membership object with roles exists from day 1, so that household workspaces (FR-24) don't need a remodel.

### 9.2 Entities

| Entity | Key contents | Rules |
|---|---|---|
| User | Identity, locale, security settings | Authenticates; never holds financial data directly |
| Workspace | Currency (EUR or USD), time zone (detected at sign-up), PR, STS settings | The isolation boundary |
| Membership | User, workspace, role (owner; others later) | — |
| Account | Class (Cash, Investment, Other asset, Liability), type, spendable flag, card-reserve flag, opening date, archived | LR-18: spendable only on Cash class. A dedicated goal account is non-spendable |
| Ledger account | Every account, every category, and the system accounts OBE, ADJ, VAL, CNV and TIT | Postings reference only ledger accounts. System accounts are system-only (LR-05) |
| Category | Kind (income or expense), parent, archived | A two-level tree. Budgets at parent **or** subcategory level per branch |
| Payee, Tag | Name, default category | Tags are Should |
| Transaction | Date, kind, origin (manual, import, rule, system), description, status, version, reconciled flag | LR-01 to LR-04; the date can't be in the future |
| Posting | Ledger account, signed integer cents, currency code | Sum = 0 per currency; non-zero lines |
| Transaction version | Before and after values, actor, time | LR-10 |
| Budget | Month, category, limit, thresholds | Spent comes from postings only |
| Recurring rule | Template; frequency; anchor day; **non-working-day setting**; **payday flag**, expected range and payer; goal link; start and end | BR-08.1, SC-1, SC-2 |
| Planned occurrence | Rule, **original date (key)**, due date, amount, status, linked transaction | No postings (LR-07) |
| Goal | Type (dedicated or virtual), target, date, creation order, linked planned payments | R5, G-1 to G-5 |
| Allocation | Goal, account, amount | Not postings (LR-08); create ≤ max(0, Bal) |
| Allocation event | Create, increase, decrease, move, release, with amounts | Atomic; audited |
| Import batch | Account, mapping profile, status, counts | Can be undone as a unit |
| Import row | Parsed fields, **fingerprint**, **ordinal**, classification, claimed transaction | The raw file isn't stored (BR-16.7) |
| Mapping profile | Column mapping, encoding, formats | Per bank format |
| Reconciliation | Account, statement date, statement balance, adjustment transaction | Locks transactions (FR-18) |
| Audit event | Type, actor, time, object, metadata (no amounts in security logs) | Append-only |
| Notification | Type, trigger, state | FR-20 |

### 9.3 Transaction lifecycle

| State | Counts in metrics | Allowed transitions |
|---|---|---|
| **Posted** | Yes | Edit (new version), Void, Trash, Reconcile |
| **Posted + Reconciled** | Yes | Unlocking requires an explicit, audited action (FR-18). After that the same transitions as Posted apply |
| **Voided** | No | Restore → Posted. A linked occurrence returns to Planned (GT-44) |
| **Trashed** | No | Restore within 30 days (OD-05), then permanent purge |

- Every transition writes an audit event.
- An edit or void that touches a reconciled transaction, or a month before a reconciliation date, triggers the warning defined in GT-42.

### 9.4 Planned occurrence lifecycle
- **Planned:** can become **Completed** (1:1 link), **Skipped** or **Cancelled**. **Overdue** is derived: due date < today and still Planned.
- **Due date vs original date:** due date = original date with the non-working-day setting applied, or a manual edit. Matching, the window H and overdue status all use the **due date**. Idempotency uses the **original date**.
- **Unlinking or voiding** a linked transaction returns the occurrence to Planned or Overdue (BR-08.8).
- **Editing a rule** regenerates only future, unedited Planned occurrences (BR-08.6).

### 9.5 Matching rules (I-4 and SC-2)

- **M-1 · Candidates:** occurrences in Planned or Overdue status, on the same account and in the same direction. A transfer rule matches either side of the transfer.
- **M-2 · Date window:** W = min(5, floor((P − 1) / 2)) days around the due date. P is the shortest gap between occurrences: weekly 7, monthly 28, yearly 365.
- **M-3 · Amount, when a suggestion is shown** (OD-04 defaults):
  - Fixed amount: ±10%.
  - Rules marked "estimated": ±30%.
  - Payday income: any amount if the payer matches. The "outside expected range" label is shown when it applies.
- **M-4 · Payer:** payday rules require a payer. A match needs the payer to agree, compared by payee rule or normalized description.
- **M-5 · Sources:** suggestions apply to manual entry, import rows and confirmations. They are never auto-applied without the user's acceptance. Exception: the user can mark a rule "auto-link exact matches" (Should).
- **M-6 · One-to-one claiming:** each existing transaction can be claimed by at most one import row, and each occurrence by at most one transaction (BR-08.4). Ties go to the nearest due date, then the earliest original date.
- **M-7 · Possible double count:** an unmatched planned item and an actual transaction on the same account, with amounts within ±10% and inside W, appear in the STS breakdown with a Link action (GT-67).
- **M-8 · Unmatching** is always allowed and is audited.

### 9.6 Import lifecycle
1. **States of a batch:** *Parsing → Review → Confirmed → (Undone)*. An unconfirmed batch can be discarded with no effect.
2. **Fingerprint:** account + date + amount in cents + normalized description + **ordinal**. The ordinal is the sequence number among identical rows in the same file (BR-16.2).
3. **Classifying each row** against prior batches and manual entries, in this order:
   - Exact duplicate of a previously imported row: skipped by default but visible (BR-16.3).
   - Claims an existing manual entry: possible duplicate, needing a decision (BR-16.4, M-6).
   - Transfer pair (BR-16.5).
   - Match to a planned occurrence (M-1 to M-4).
   - New.
4. **Confirm:** all rows are created atomically (LR-03).
5. **Undo import:** voids every transaction in the batch. It restores claimed manual entries and returns occurrences to Planned (BR-16.6, GT-38). If the batch contains reconciled transactions, undo is blocked until they're unlocked.

### 9.7 Edits, history and audit
- Edits replace postings atomically and store a version (LR-10).
- **Undo** means "revert to the previous version" for the last action within the session, plus the history view per transaction.
- The audit log covers security events and financial events (create, edit, void, reconcile, unlock, allocation events, imports, exports, deletion requests). A full audit viewer is on the contingency cut list (AP-07).

### 9.8 Archiving, closing and deletion
- An account can be archived only with balance 0, no allocations and no Planned occurrences.
- An archived account or category can't receive postings (LR-14).
- Merging categories re-points postings and budgets in one atomic step (GT-45).
- **Workspace deletion:** the owner confirms, re-authenticates, and is offered an export first. The workspace is then purged under OD-07.

---

## 10. Currency and precision

### 10.1 Representation
- Money is a **signed integer number of cents plus an ISO 4217 code** on every posting. In the MVP the code is always the workspace currency, **EUR or USD** (CUR-1, FR-23). Both have 2 decimal places, so every rule below applies to both unchanged.
- No binary floating point anywhere in money paths (NFR-02). Amounts cross API boundaries as integer minor units or decimal strings.
- Exchange rates (future) are decimal strings with at least 6 significant digits.

### 10.2 Rounding: one rule per operation

| Operation | Rule |
|---|---|
| Percentage splits, proportional goal backing | Largest-remainder method; ties go to line order or goal creation order (GT-05, GT-52) |
| Per-day STS | Rounded down to the cent (ER-1) |
| Monthly amount needed for a goal | Rounded up to the cent |
| Budget utilization display | Truncated to 1 decimal. Alerts use the integer comparison Spent×100 ≥ Limit×threshold (AM-3, GT-57) |
| Input with more than 2 decimals | Rejected with a message; never silently rounded |

### 10.3 Input and display
- Accept the number formats of every supported locale (for example "1234,56", "1 234,56", "1.234,56", "1,234.56") and the bank file encodings listed in FR-16. The import mapping confirms the format; it's never guessed silently.
- Ambiguous separators in import mapping must be confirmed in the preview.
- Display follows the locale rules of the i18n library for the user's language (for example "1.234,56 €" in German, "€1,234.56" in English, "1 234,56 €" in Bulgarian), always with a true minus sign. This is verified by UI tests per locale rather than hand-formatted.

### 10.4 Workspace currency and BGN (CUR-1)
- A workspace is in **EUR or USD**, chosen at creation and locked after the first transaction (BR-23.1, BR-23.2).
- There is **no currency conversion anywhere in the MVP**, so no exchange rates, no revaluation and no conversion rounding.
- **BGN is not supported.** Bulgaria adopted the euro on 1 Jan 2026, so current Bulgarian statements are in EUR. Statements from before 2026 in BGN can't be imported; rows marked BGN are rejected (BR-23.4). A user who wants older history starts tracking with an opening balance on their chosen start date.
- **Accounting clarification (AP-14, unchanged):** the Net Worth identity includes the CNV effect. CNV receives no postings in the MVP, so its effect is always 0; the term keeps the identity complete for future multi-currency.

### 10.5 Future multi-currency within a workspace (FR-23, Later; constraints are Must)
- Every account has one currency. Postings balance **per currency** (LR-01 already does).
- A cross-currency transfer will use a trading or conversion account (CNV) so that each currency balances.
- There will be a rate table (date, pair, rate, source):
  - Transactions record a base-currency equivalent at the **transaction-date rate**.
  - Balance sheets use the **reporting-date rate**.
  - The difference is shown as **FX revaluation**: a separate line, never counted in Income or Expenses.

### 10.6 Dates and time zone
- A transaction date is a calendar date in the workspace time zone. "Today", month boundaries and H are computed in the workspace time zone (GT-58 uses Europe/Sofia).

---

## 11. Security, privacy and commercial requirements

*These are product requirements. Where a law may apply, I list it as a question for counsel (LQ), not as compliance. Nothing here claims legal compliance.*

### 11.1 Security (SEC)

| ID | Requirement | Priority |
|---|---|---|
| SEC-01 | Authentication per FR-01: strong passwords checked against known breaches, 2FA, rate limiting and lockout, verified email, safe reset, re-authentication for sensitive actions | Must |
| SEC-02 | Workspace isolation enforced at two independent layers, with automated cross-tenant tests (GT-59) and pen-test coverage | Must |
| SEC-03 | TLS in transit; encryption at rest, including backups; secrets kept outside the code | Must |
| SEC-04 | No staff access to user financial data by default. Support access only with the user's explicit, time-limited consent, and audited (OD-13) | Must |
| SEC-05 | Logs and monitoring carry no amounts, descriptions or payees (NFR-12) | Must |
| SEC-06 | OWASP ASVS Level 2 baseline, dependency scanning, external pen test before public launch (NFR-06) | Must |
| SEC-07 | Incident response plan, including the ability to assess and notify a breach within legal deadlines (LQ-01) | Must |
| SEC-08 | Backups with RPO ≤ 1 h and RTO ≤ 8 h, plus quarterly restore drills (NFR-05) | Must |
| SEC-09 | CSRF and XSS protection, a strict content security policy, and file-upload checks on CSV (size, type, rows; BR-16.8) | Must |

### 11.2 Privacy (PRV)

| ID | Requirement | Priority |
|---|---|---|
| PRV-01 | **Data minimization:** never ask for bank credentials (CSV only) and never store card numbers. Raw import files are discarded | Must |
| PRV-02 | Transaction descriptions can contain third-party personal data (names, IBANs) and are treated as personal data | Must |
| PRV-03 | Self-service export of all data (FR-17) and self-service deletion (OD-07) | Must |
| PRV-04 | No third-party trackers or advertising SDKs. Only essential cookies, so a consent banner isn't needed if this holds (LQ-03) | Must |
| PRV-05 | Hosting and subprocessors in the EU/EEA, with a published subprocessor list (the provider is chosen in Stage 2) | Must |
| PRV-06 | Retention: trash 30 days; audit log 24 months; backups age out ≤ 35 days after deletion (OD-05 to OD-07) | Must |
| PRV-07 | Masking of IBANs in descriptions | Could |

### 11.3 Commercial (COM)

| ID | Requirement | Priority |
|---|---|---|
| COM-01 | Terms of service, privacy notice and a "not financial advice" statement, shown at signup and in the app | Must for launch |
| COM-02 | No personalized investment or credit recommendations. STS and projections are labelled as estimates based on the user's data | Must |
| COM-03 | Subscriptions through a hosted payment provider, so card data never touches our servers (OD-10, OD-11) | Must for paid launch |
| COM-04 | Feature limits enforced per workspace plan (FR-24 constraint) | Later |
| COM-05 | Minimum age 18 (OD-12) | Must |
| COM-06 | Accessibility target WCAG 2.1 AA (NFR-08), whatever the EAA outcome | Must |

### 11.4 Questions for qualified counsel (LQ)
- **LQ-01:** GDPR roles, legal bases, records of processing, breach notification (72 hours to the supervisory authority, КЗЛД), and whether a DPIA is required for this financial data.
- **LQ-02:** DPA terms with each subprocessor and any transfer outside the EEA.
- **LQ-03:** ePrivacy and cookies in each launch country, given essential cookies only.
- **LQ-04:** consumer law for digital subscriptions: the 14-day withdrawal right and its waiver, auto-renewal and cancellation rules, and price display.
- **LQ-05:** whether the European Accessibility Act (applicable since 28 Jun 2025) covers this product and its checkout.
- **LQ-06:** confirmation that CSV-only import and no advice keep us outside PSD2 account-information and investment-advice regulation, and what future bank sync would need (a licensed partner).
- **LQ-07:** VAT on digital services (OSS) versus using a merchant of record.
- **LQ-08:** retention periods in PRV-06, and minimum age in each launch country.
- **LQ-10 (MKT-1):** which launch countries come first, and in which languages the terms, privacy notice and pre-contract information must be provided in each country, and in particular whether an **English-only launch** may be marketed in non-English-speaking EU countries.
- ~~LQ-09~~: withdrawn. BGN conversion was removed by CUR-1.

---

## 12. Prioritized MVP and development sequence

### 12.1 MVP scope (unchanged from §3, plus approvals)
- **Must:**
  - FR-01 to FR-12, FR-14, the FR-15 core, FR-16 to FR-19.
  - FR-21 responsive layout and FR-22 in 7 languages, phased (MKT-1, MKT-2).
  - The FR-23 and FR-24 design constraints.
  - SC-2 payday marker and SC-3 "Save for a bill".
  - The SEC, PRV and COM items marked Must.
- **Should:** FR-13, FR-20 in-app notifications, SC-1, the payday auto-suggestions, Excel import, investments, tags.
- **Must, added by CUR-1:** the workspace currency choice, EUR or USD (FR-23).
- **Contingency cut order (AP-07):**
  1. Two bank profiles instead of more.
  2. Weekly, monthly and yearly frequencies only.
  3. Three core reports.
  4. No audit viewer.
  5. Manual allocation moves.
  6. Only the last reconciliation is kept.

### 12.2 Approved sequence within the stages
The stage names are unchanged. The import work (Stage 7 content) runs right after Stage 4 (AP-15, approved).

| Order | Stage | Content | Exit criteria |
|---|---|---|---|
| 1 | **2 · Technical Architecture** | Decisions OD-01 to OD-03; logical data model from §9; threat model; isolation design; test strategy (golden tests as the executable spec); environments. In parallel, **wireframes for the 6 key screens plus 3–5 user tests of STS comprehension** (OD-15) | Your approval of the architecture and wireframes |
| 2 | **3 · Database Implementation**, done as a *ledger-core slice* | Auth, workspaces, accounts, postings, categories, transactions, splits, refunds. The schema grows through migrations, never all upfront. **Staging environment live** | GT-01 to GT-27, GT-39, GT-59, GT-70, GT-71 pass; the workspace currency choice (EUR or USD) works; isolation tests pass; staging deploy works |
| 3 | **4 · Core Application** | Account and transaction UI, reconciliation, history, undo and audit, export, responsive layout | GT-40 to GT-45 pass; usable at 360 px (export round trip: a Should, D-2) |
| 4 | **7 · Importing and Automation** (moved forward) | CSV import, mapping profiles, fingerprints, claiming, undo import | GT-09, GT-35 to GT-38 pass; 2,000 rows in < 10 s |
| 5 | **5 · Budgeting and Financial Planning** | Budgets, recurring rules, matching, goals, cards and debts, calendar, STS | GT-16 to GT-20, GT-28 to GT-34, GT-48 to GT-57, GT-61 to GT-69 pass |
| 6 | **6 · Analytics and Reporting** | Dashboard, core reports, projection | GT-60 passes; dashboard p95 < 1.5 s |
| 7 | **8 · Testing and Security** (hardening only) | External pen test, ASVS L2 review, load test, restore drill, accessibility audit, property-based tests of the ledger invariants | No open high-severity findings; restore drill passes |
| 8 | **9 · Deployment** | Production, monitoring, legal documents, closed beta, then launch | The gates in 12.3 |

Financial logic is written test-first from the first line of domain code in every stage. Stage 8 doesn't introduce testing; it hardens.

### 12.3 Release gates
- **G1:** all golden tests pass, and the nightly integrity job reports 0 imbalances (NFR-01).
- **G2:** isolation tests and the pen test are clean.
- **G3:** a restore drill succeeded within the RTO.
- **G4:** counsel has answered LQ-01, LQ-04 and LQ-06; legal documents are published.
- **G5:** the closed beta shows that users read STS correctly in the wireframe-test sense, meaning they can explain what the figure means.

---

## 13. Requirements traceability matrix

| Requirement | Spec | Rules | Golden tests | Stage |
|---|---|---|---|---|
| FR-01 Auth | §3, §11 SEC-01 | — | Security tests (not golden) | 3 |
| FR-02 Isolation | §9.1, SEC-02 | — | GT-59 | 3 |
| FR-03 Accounts, opening balances | §5, §9.2 | LR-05, LR-18 | GT-01, GT-02 | 3 |
| FR-04 Transactions, refunds, adjustments | §5 | LR-01 to LR-06, LR-15 | GT-03, GT-06 to GT-10, GT-21 to GT-27 | 3 |
| FR-05 Categories | §9.8 | LR-14 | GT-45 | 3 |
| FR-06 Splits | §5, §10.2 | LR-17, AM-5 | GT-04, GT-05 | 3 |
| FR-07 Budgets | §4, §10.2 | AM-3 | GT-25, GT-57, GT-63 | 5 |
| FR-08 Recurring | §9.4, §9.5 | LR-07, BR-08.x, SC-1, SC-2 | GT-20, GT-28 to GT-31, GT-62, GT-64, GT-67, GT-68 | 5 |
| FR-09 Goals | §8 | LR-08, AM-1, R5, G-P4 | GT-48 to GT-54, GT-65, GT-66 | 5 |
| FR-10 Cards, debts | §5 | LR-06 | GT-11 to GT-19, GT-55, GT-69 | 5 |
| FR-11 Calendar | §9.4 | — | GT-31 | 5 |
| FR-12 STS | §7 | R1 to R8, P1 to P8, AM-1, option (c) | GT-16, GT-32 to GT-34, GT-55, GT-56, GT-61, GT-61b, GT-62, GT-65 to GT-69 | 5 |
| FR-13 Projection | §7, ER-4 | I-12 | GT-69 | 6 |
| FR-14 Dashboard | §3 | LR-16 | GT-61 | 6 |
| FR-15 Reports | §5.3 | LR-16, I-9 | GT-24, GT-60 | 6 |
| FR-16 Import | §9.5, §9.6 | BR-16.x, M-1 to M-8 | GT-09, GT-35 to GT-38, GT-67 | 4* |
| FR-17 Export | §11 PRV-03 | — | Round-trip acceptance criterion | 4 |
| FR-18 Reconciliation | §9.3 | LR-13 | GT-40 to GT-42 | 4 |
| FR-19 History, undo, audit | §9.3, §9.7 | LR-10, LR-11 | GT-38, GT-39, GT-43, GT-44 | 4 |
| FR-20 Notifications | §3 | — | GT-25 (thresholds) | 5 |
| FR-21 Responsive | §3 | — | Acceptance at 360 px | 4 |
| FR-22 Localization | §10.3 | — | UI formatting tests | 4 |
| FR-23 Workspace currency (EUR or USD) and multi-currency constraints | §10.4, §10.5 | LR-01, BR-23.x | GT-70, GT-71, architecture checklist | 2 (constraints), 3 (currency choice) |
| FR-24 Household and commercial constraints | §9.1, COM-04 | — | Architecture checklist | 2 |
| NFR-01 and NFR-02 Accuracy and precision | §10 | LR-17 | All; especially GT-05, GT-52, GT-57 | All |
| NFR-05, NFR-06, NFR-12 | §11 | — | Restore drill, pen test | 8 |
| Investments (Should) | §5 | LR-12 | GT-46, GT-47 | 6 |
| Time zone | §10.6 | LR-04 | GT-58 | 3 |

\*Done in the moved-forward slot (order 4), per AP-15.

**Gaps found:**
- FR-01 has no golden test. That's correct, since it isn't financial logic. Its acceptance tests are defined in Stage 2.
- FR-17's round trip (a Should, D-2) and FR-22's formatting need automated tests named in Stage 2.

---

## 14. Open Decisions Register

**Confirmed (no further action):** B-1 to B-5, D-2, D-7, D-15 to D-17, S-1 to S-8, G-1 to G-5, A-1 to A-10, AM-1 to AM-5, ER-1 to ER-6, I-1 to I-14 (via AP-01 to AP-08), and AP-09 to AP-13.

**Open:**

| ID | Decision | My default | Blocks Stage 2 start? | Must be decided by |
|---|---|---|---|---|
| OD-01 | Hosting provider (EU/EEA) | — | No; it's decided *in* Stage 2 | End of Stage 2 |
| OD-02 | Managed auth provider vs self-built | Managed | No; decided in Stage 2 | End of Stage 2 |
| OD-03 | Final tech stack | The direction from the brief assessment (TypeScript, Next.js, PostgreSQL) | No; decided in Stage 2 | End of Stage 2 |
| OD-04 | Matching tolerances (M-3) | ±10% fixed, ±30% estimated, payer-based for payday | No | Stage 5, validated with real data |
| OD-05 | Trash retention | 30 days | No | Stage 4 |
| OD-06 | Audit log retention | 24 months | No | Stage 4 (LQ-08) |
| OD-07 | Deletion: erase within 30 days; backups ≤ 35 days | As stated | No | Stage 4 (LQ-08) |
| ~~OD-08~~ | BGN history import | **Closed by CUR-1: dropped** | — | — |
| OD-09 | Public holidays in the non-working-day setting | Later (weekends only); per-country calendars when added (MKT-1) | No | Stage 5 |
| OD-10 | Pricing and free tier | — | No | Before paid launch |
| OD-11 | Merchant of record vs own VAT handling | — | No | Before paid launch (LQ-07) |
| OD-12 | Minimum age | 18 | No | Stage 9 (LQ-08) |
| OD-13 | Support access model | Consent-based, time-limited | No | Stage 2 |
| OD-15 | STS comprehension tests at the wireframe stage | Required, 3–5 users | No | Before Stage 5 UI |
| ~~OD-16~~ | English localization timing | **Closed by MKT-1:** English and 7 more languages at launch | — | — |
| OD-17 | A user with both EUR and USD money: since A-5 gives each user one workspace and a workspace has one currency, they can track only one of them | Accept for the MVP. Allow a second personal workspace later (it fits the FR-24 design) | No | Stage 2 |
| OD-18 | How USD is shown in each language: "$" or "USD", and its position | Follow each locale's standard format from the i18n library | No | Stage 2 wireframes |

**Nothing in the register blocks the start of Stage 2.** OD-01 to OD-03 and OD-13 are Stage 2's own work.

---

## 15. Final review checklist and approvals

**Deliverables A–L:** all delivered, and consolidated in this document with every amendment merged in place (AM-1 to AM-5, ER-1 to ER-6, AP-01 to AP-17, SC-1 to SC-6).

**Quality checks:**
- [x] Every metric and formula has at least one golden test with exact numbers.
- [x] Planned items never affect actual figures (LR-07, GT-28).
- [x] No double counting: card reserve (GT-16, GT-69), goals and bills (GT-66), plans and actuals (GT-67), transfers (GT-09).
- [x] Integer cents and one rounding rule per operation (§10.2).
- [x] Every competitor-derived idea was checked against the accounting rules. No rule was changed on market grounds.
- [x] Legal items are listed as questions, with no compliance claimed.
- [x] Every decision is either confirmed or in the register with a default.
- [x] No code, schemas or infrastructure were created. This document is the only project file.

**Approvals (all granted 2 Nov 2026):**
- **AP-14:** the Net Worth identity explicitly includes CNV (a clarification, §10.4).
- **AP-15:** the import work (Stage 7 content) runs right after Stage 4, as in §12.2.
- **AP-16:** the register defaults OD-04 to OD-16 are working assumptions.
- **AP-17:** the corrected GT-32 values (1,070 and 2,420) and the new tests GT-62 to GT-69.
- **Final:** the Stage 1 specification is approved; Stage 2 may begin once the user gives the go-ahead.

**Changes after approval:**
- **CUR-1 (user decision, 2 Nov 2026):** EUR and USD are the only currencies, one per workspace, both in the MVP. All BGN support is dropped. This amends C-2, closes OD-08, withdraws LQ-09 and adds FR-23 rules BR-23.1–BR-23.5, GT-70, GT-71, OD-17 and OD-18. The accounting rules are unchanged.
- **MKT-1 (user decision, 2 Nov 2026):** the product targets the EU first, not only Bulgaria. It launches in English, Bulgarian, German, Spanish, Italian, Russian, French and Greek, and automatic bank/card connection is planned for release 1.1. This amends C-7, C-9, A-1, BR-05.2, FR-16 (encodings), FR-22 and §10.3; closes OD-16; widens OD-09, OD-18, LQ-03 and LQ-08; and adds LQ-10. The accounting rules are unchanged.
- **MKT-2 (user decision, 2 Nov 2026):** Russian is dropped, leaving 7 languages. Each language is switched on separately when its translations and legal texts are ready, instead of all at once. Amends FR-22, C-7 and LQ-10. **At launch only English is switched on**; the other six languages follow later, in the order of the ad markets.
- **PK-1 (user decision, 4 Nov 2026):** passkeys (sign-in with Face ID, Windows Hello, a fingerprint or a device PIN) move from "later" into the first release. No biometric data reaches the product. Passwords stay as the backup. The accounting rules are unchanged.

- **D-2 (user decision, 5 Nov 2026):** re-importing a full export stays a Should (AC-17.4), so it is no longer a Stage 4 exit criterion in §12.2.

**Corrections made while consolidating (they follow directly from the approved option (c); confirmed by the user on 2 Nov 2026):**
- **GT-33:** STS on 26 Mar becomes **420** (was 400), and after the late salary **2,420** (was 2,400), because the phone bill on 25 Apr falls on payday.
- **§7.8 Example 1:** STS becomes **1,085** (was 785), because the loan instalment is due on payday. On payday itself, before the salary is recorded, it's 785.

---

# Appendix A. Issue review I-1 to I-14 (rationale behind the approved decisions)

*Kept as written at review time (1 Nov 2026) for the reasoning. All recommendations below were approved (AP-01 to AP-08), I-5 as revised by SC-2. Where this appendix and the main sections differ, the main sections are binding.*

The issues fall into four groups, in order of severity:

- **A:** issues that change formulas or test results. These need decisions before Part 4.
- **B:** choices about how specific transactions are recorded.
- **C:** how numbers are presented to users.
- **D:** MVP scope.

## Overview

| # | Issue | Group | Severity | Blocks Stage 2? | My recommendation |
|---|---|---|---|---|---|
| I-1 | Spending that eats into goal money (AM-1) | A | Critical | Yes | Approve AM-1, plus a "spending from goal money?" prompt |
| I-2 | Bills due on payday (S-4) | A | High | Yes | **Change my earlier recommendation**: exclude the payday itself, with one exception |
| I-3 | Bills that a goal is saving for (R5) | A | High | Yes | **Promote from Should to Must**, in a simplified form |
| I-4 | Double counting when a payment isn't matched to its plan | A | High | Yes | Stronger matching rules (4 additions) |
| I-5 | Dependence on the "reliable income" flag | A | Medium | No | Guardrails, with onboarding prompts |
| I-6 | Card instalment plans and budgets | B | Medium | No | Full expense at purchase in the MVP |
| I-7 | Large purchases financed by a loan | B | Low | No | Expense by default; asset as an option |
| I-8 | Cashback | B | Low | No | Income category "Cashback & rewards" |
| I-9 | Which month a refund counts in | B | Medium | Yes (budget logic) | The refund month |
| I-10 | Overdrawn accounts: asset or liability | B | Low | No | Keep them as negative assets |
| I-11 | The name "net cash flow" | C | Medium | No | Two clearly named figures |
| I-12 | Safe to Spend and the cash-flow projection disagree about cards | C | Medium | No | **New rule** that makes them agree |
| I-13 | Safe to Spend is often negative for some users | C | Medium | No | Onboarding, a freshness indicator, wording |
| I-14 | The MVP is too big | D | High | Partly | Defined cut list |
| — | Small gaps found while re-checking | — | Low | No | Corrections listed at the end |

---

## Group A: issues that change formulas or test results

### I-1 · Spending that eats into goal money (amendment AM-1)

**The problem.** The original formula from Part 1 only subtracted goal money that was still physically in a spendable account. Once spending ate into that money, Safe to Spend stopped falling and stayed at €0 while the user kept spending:

| Current account | Allocated to House | Old formula | AM-1 |
|---|---|---|---|
| 3,000 | 2,000 | 1,000 | 1,000 |
| After spending 1,500 → 1,500 | 2,000 | **0** | **−500** |
| After spending another 500 → 1,000 | 2,000 | **0** (still) | **−1,000** |

Under the old formula, the indicator says "€0" and stays there however much more is spent. That's exactly the warning signal it exists to give, and it disappears.

**What AM-1 changes.** It subtracts the full allocation on spendable accounts. On non-spendable accounts it subtracts only the shortfall (the part of the allocation no longer backed by money in that account). The result is two simple properties users can rely on:

- Every euro spent from spendable money lowers Safe to Spend by exactly €1.
- Moving money between the user's own accounts never turns goal money into spendable money.

**A new side effect I hadn't addressed.** Suppose a user has a car repair and pays it straight from Savings, where their emergency fund is allocated. Under AM-1, Safe to Spend drops, possibly below zero. Accounting-wise that's correct: the goal now has a shortfall. But to the user it reads as "I used my emergency fund for an emergency and the app is punishing me."

**Fix:** whenever an expense is recorded against an account that holds allocations, the app asks:

> "Is this paid from your goal money? [Emergency fund €X] [Vacation €Y] [No]"

Choosing a goal applies "use goal money", which releases the allocation (rule E-48). Safe to Spend then doesn't drop, and the goal shows the money as used. This adds one step to entry, but only for accounts that hold allocations.

**Recommendation:** approve AM-1 together with this prompt, recorded as new rule G-P4.

---

### I-2 · Bills due on payday (S-4): I'm revising my recommendation

**The problem.** In Part 3 I recommended that the Safe to Spend window *includes* the payday itself. In the GT-61b scenario, rent and salary both fall on the 1st, and the evening before payday the user sees **"Shortfall €77"**. If rent and salary share a date, that happens **every month**. Users will learn to ignore the indicator, and then it's worthless when a real shortfall comes.

**Options:**

| Option | Last day before payday | On payday, salary not yet recorded | On payday, salary recorded | Risk |
|---|---|---|---|---|
| (a) Include payday (my earlier recommendation) | −77 (false alarm every month) | −77 | Correct | Users ignore the indicator |
| (b) Exclude payday always | 523 | 523 (rent not protected) | Correct | One day of under-protection if the salary is late |
| **(c) Exclude payday, but include items due today when the salary is due today and hasn't arrived** | **523** | **−77** (true: the money isn't there) | Correct | Smallest |
| (d) Per-bill setting "paid after salary arrives" | Configurable | Configurable | Correct | More setup for users |

**Recommendation: (c).**

- The bill window runs from today up to, but not including, payday.
- On payday itself, while the reliable income is still unmatched, items due that day are counted.
- Items due on payday are shown on their own information line ("Due on payday: Rent €600"), so the user isn't surprised the next day.

**Effect on the golden tests:**
- GT-32: on 25 Mar before the salary arrives, the value is unchanged at **1,050**, because that case is still covered by the exception.
- GT-61b: on 31 Oct the value becomes **523** instead of −77. On 1 Nov, until the salary is recorded, it's **−77**.

---

### I-3 · Bills that a goal is saving for (rule R5)

**The problem.** In Bulgaria, saving ahead for annual bills is extremely common: car liability insurance, property tax, the vignette, the annual car inspection. A diligent user does both things the app encourages:

1. Allocates €300 to an "Insurance" goal.
2. Schedules the €360 insurance payment.

Without R5, Safe to Spend subtracts **€660**, which is €300 too much. Because R5 was only a Should Have, the most careful users would have hit the double count first. The error goes in the safe direction (too conservative), but it violates the brief's rule that nothing is subtracted twice, and those users would stop trusting the number.

**Recommendation: promote R5 to Must, in a simplified form.**

- A planned payment can be linked to **one** goal. Each goal can be linked to any number of planned payments.
- Coverage is calculated in due-date order. Each payment counts as max(0, amount − the goal's remaining backed money).
- Confirming a linked payment automatically offers "use goal money".
- Non-spendable source: if the goal money sits in Savings and the bill is paid from Current, there's a temporary dip of the covered amount between paying the bill and moving the money over. I'm stating this explicitly as accepted behaviour. The prompt suggests "Move €300 from Savings now?"

**Cost:** moderate. It's one link field plus one rule inside a calculation that's already being built.

---

### I-4 · Double counting when a payment isn't matched to its plan

**The problem.** If a scheduled rent payment and the actual rent payment aren't linked, Safe to Spend subtracts rent twice. GT-37 shows the size of the error: −700 instead of −100. Part 3 handled the import case. Re-checking found three more gaps:

1. **Manual entries.** A user who types "Rent €600" by hand also gets no link. **Fix:** matching suggestions apply to manual entry too: "This looks like your planned Rent (due 25 Mar). Link it?"
2. **Weekly rules.** The ±5-day matching window can match the wrong week. **Fix:** window = min(5 days, floor((period in days − 1) / 2)). That's 3 days for weekly rules and 5 days for monthly ones.
3. **One-to-one claiming.** In GT-35, a third legitimate €2.50 coffee could have been flagged as a possible duplicate of coffees that were already matched. **Fix:** each existing transaction can be claimed by at most one import row. Rows with no unclaimed candidate are treated as new.
4. **Visibility.** **Fix:** any unmatched pair of a planned item and an actual transaction that look alike (same account, amount within ±10%, within the matching window) is listed inside the Safe to Spend breakdown as "Possible double count: €600", with a one-tap link action.

**Recommendation:** add all four. They go into §9 (transaction lifecycle) in Part 4.

---

### I-5 · Dependence on the "reliable income" flag

**The analysis.** The flag only moves the end of the Safe to Spend window. It never adds income to the figure. That limits the risk:

| User error | Effect | Direction |
|---|---|---|
| Forgets to mark the salary as reliable | A 30-day window, so next month's bills are counted too | Too conservative (safe) |
| Marks irregular income as reliable | The window ends at an uncertain date, and bills after it aren't protected | **Too optimistic (risky)** |
| Reliable income arrives late | The overdue income is ignored, the window extends, Safe to Spend drops, and a warning appears | Corrects itself |

**Guardrails I recommend:**

- The reliable flag is allowed only on recurring income rules with a fixed amount.
- The app *suggests* the flag after 2 on-time payments in a row, and never sets it automatically.
- If the income arrives late 2 times out of the last 3, the app suggests removing the flag.
- Onboarding asks directly: "When do you usually get paid?"

---

## Group B: how specific transactions are recorded

### I-6 · Card instalment plans and budgets (D-15)

Example: a TV for €600, paid as 6 × €100. Accounting-wise it's €600 of spending at purchase, but users budget it as €100 a month.

| Option | Reports | Budgets | Problem |
|---|---|---|---|
| **(a) Full expense at purchase** | Correct | €600 in one month | The month looks overspent |
| (b) Spread over 6 months for budgets only | Full €600 | €100 per month | Budget totals no longer match reports, which breaks AC-07.5. That's confusing. |
| (c) Recognise the expense gradually | €100 per month | €100 per month | Violates the "expense at purchase" invariant and needs an accrual concept |

**Recommendation:** (a) in the MVP, with a one-line note on the overspent budget ("includes instalment purchase TV €600"). Revisit (b) after real user feedback. If it's adopted, the budget view must label spread amounts explicitly.

### I-7 · Large purchases financed by a loan (D-16)

Recording a €15,000 car as an expense makes net worth fall by €15,000, although the user still owns the car. Recording it as an asset keeps net worth honest, but then needs valuation updates.

**Recommendation:** default to expense. Show a "Track as an asset" option for purchases of €5,000 or more, or in the categories Vehicle and Property. Valuation reminders for assets come later.

### I-8 · Cashback (D-17)

**Recommendation:** an income category "Cashback & rewards". Cashback rarely maps to a single purchase, so treating it as a refund against a category would be guesswork.

### I-9 · Which month a refund counts in (B-2)

| Option | Effect |
|---|---|
| **The refund month (recommended)** | Closed months never change, which matches bank statements. A category can show negative spending in a month. |
| The original purchase's month | Budgets read more "truly", but last month's reports change after the fact, and reconciliations based on them break. |

I keep the refund-month recommendation. It's needed now because budget logic depends on it.

### I-10 · Overdrawn accounts

Net worth is identical either way. Only how the Assets and Liabilities totals are split changes. **Recommendation:** keep an overdrawn current account as a negative asset. A separate overdraft credit line can be set up as a liability account by the user.

---

## Group C: how numbers are presented

### I-11 · The name "net cash flow"

GT-12 shows why one name isn't enough: spending was €60 but cash fell by only €50, because €10 is still owed on the card.

**Recommendation:**

- Dashboard: **"Income − Expenses"** (Bulgarian: "Приходи − Разходи"). This is the Net Result.
- Reports: **"Change in cash"** (Bulgarian: "Промяна в наличностите"). This is the Cash Change.
- The term "net cash flow" isn't used anywhere in the UI.

### I-12 · Safe to Spend and the cash-flow projection disagree about cards: proposed fix

**Current inconsistency:**
- Safe to Spend reserves the whole card balance today.
- The cash-flow projection subtracts card money only when a repayment is scheduled.

If no repayment is scheduled, the projection never shows the card debt, and the two figures contradict each other.

**New rule:** for a card whose balance is reserved but which has no scheduled repayment, the projection subtracts the card balance on day 0. When a repayment *is* scheduled, the projection uses its date and amount, and the information line explains "Card €60 reserved now, paid on 5 Nov".

**Result:** Safe to Spend equals the projection's starting value on the "commitments only" line, minus the protected reserve and goal allocations, which is a check the tests can run automatically.

### I-13 · Safe to Spend is often negative for some users

Re-checking showed that a user with monthly bills but **no reliable income set up** sees roughly one month of bills subtracted at all times. In GT-37 that's €600 of rent and a value of −€100. The figure is correct, but discouraging.

**Mitigations:**

1. Onboarding asks for the salary or main income and suggests marking it reliable.
2. Below the figure, the window is always stated: "until 25 Mar" or "for the next 30 days (no regular income set)".
3. A **data freshness indicator**: "Last bank import: 12 days ago". Safe to Spend is only as current as the data behind it. Manual-entry and import-based users must see that, especially when the figure looks wrong.
4. The wording for negative values is "You need €X more to cover what's planned" rather than an alarming red "−€X".

---

## Group D: MVP scope

### I-14 · The MVP is too big

Including the promotion of R5, the Must list has about 20 feature areas. Here's a cut list in recommended order, where each cut keeps financial correctness intact:

| Order | Cut or simplification | Saving | Cost to users |
|---|---|---|---|
| 1 | Bank import profiles for 2 banks only (others through manual column mapping) | Medium | Some extra setup |
| 2 | Recurring frequencies limited to weekly, monthly and yearly (no "every N") | Small | Rare cases |
| 3 | Reports: 3 core reports only (by category, monthly trend, period comparison) | Medium | Less insight |
| 4 | Audit trail kept for every action, but with no viewing screen for users | Small | No visible history |
| 5 | Moving allocations together with a transfer (G-T2) left to manual steps | Small | More taps |
| 6 | Reconciliation without stored history (last reconciliation only) | Small | Less traceability |

**Not cuttable without breaking correctness or a confirmed decision:**
- The ledger and its accounting rules.
- Isolation between users.
- Planned↔actual matching.
- Safe to Spend.
- Both kinds of goals (confirmed decision C-3).
- CSV import with duplicate detection and undo.
- Reconciliation in its basic form.
- Export.

The full release plan follows in Part 4 §12.

---

## Small gaps found while re-checking my own work

| # | Where | Gap | Correction |
|---|---|---|---|
| ER-1 | §7.8, example 1 | The "per day" figure, €785 / 8 = 98.125, was shown as 98.12, but no rounding rule was stated. Ordinary rounding would give 98.13. | New rule: per-day amounts are **rounded down to the cent**, so they never overstate. 98.12 stands. |
| ER-2 | §9 (pending) | Matching window for weekly rules | As in I-4, item 2 |
| ER-3 | §9 (pending) | Duplicate import rows could be matched to the same existing transaction more than once | One-to-one claiming (I-4, item 3) |
| ER-4 | FR-13 | Projection and card reserve inconsistent | I-12 |
| ER-5 | §7.11 | Overdue items stay in Safe to Spend forever if never resolved | Overdue items older than 30 days produce a monthly "Still unpaid?" prompt. They remain counted until the user resolves them. |
| ER-6 | §7.2 | A card balance that will be paid from Savings is still reserved, which is over-conservative | Documented. Users can switch the reserve off for that card. No rule change. |

---

---

# Appendix B. Competitor study (research, 1 Nov 2026)

*Kept as written at research time for its sources and reasoning. Its recommendations were approved as AP-09 to AP-13; where it differs from the main sections, the main sections are binding.*

**How I did it.** I used web research only, in November 2026, and did not test any app hands-on. I covered 8 apps: YNAB, PocketGuard, Quicken Simplifi, Monarch, Copilot Money, Emma, Actual Budget and Monzo.

**Limitations:**
- PocketGuard's and Monarch's help centres blocked direct access. For those I could only read the excerpts shown in search results.
- User complaints come from forums and app reviews. They show which problems exist, not how common they are.
- All 8 apps are aimed at the US or UK market. I did not study any Bulgarian or other EU apps.

**How each claim is marked:**
- **[V]**: verified in official documentation that I read.
- **[V-s]**: official page, but read only through a search-result excerpt.
- **[U]**: user-reported, or a staff reply in a forum.
- **[I]**: my interpretation.
- **Unknown**: not publicly documented. I did not guess any formula that isn't published.

---

## B.1 Comparison table

| App | Indicator name | Based on | Period | Expected income added? | Goals | Card spending | Unused credit limit counted? |
|---|---|---|---|---|---|---|---|
| **YNAB** | Ready to Assign, and Available per category | Money already in accounts that hasn't been assigned to categories [V] | Calendar month | **No.** Only money already in accounts counts [V]. Its official guides advise budgeting money you already have [V] | Categories with Targets | Spending moves money into a "Credit Card Payment" category. Debt from before you started must be assigned manually [V] | **No.** Spending beyond your cash shows as "credit overspending", meaning borrowed money [V] |
| **PocketGuard** | Leftover (earlier versions called it "In My Pocket") | Income, **not your balance**: "Income − Expenses − Goals" [V-s] | Month | **Yes**, an estimate that is updated when paychecks arrive [V-s] | Subtracted [V-s] | Payments between bank and card are excluded as transfers [V-s] | Unknown |
| **Simplifi** | "Left this month" (marketing calls it Available to Spend) | Plan, not balance. It "does not consider existing account balances" [V] | Month; resets on the 1st [U] | Recurring income plus extra deposits [V] | The monthly contribution is subtracted [V] | Card payments are excluded by default [V]. Card spending is counted when you buy [U, staff reply] | Unknown |
| **Monarch** | Flex number, Left to budget | "Income − Fixed − Non-monthly − Goals" [V] | Month [I] | Expected income is the baseline for variable earners [V] | Goals 3.0 lets you allocate account balances to goals, with "Available for goals" and over-allocation alerts [V-s] | Not verified | Unknown |
| **Copilot** | Free to Spend | Monthly budget minus spending; recurring items are excluded from the chart [V]. **Exact formula unknown** | Month | Unknown | Unknown | Card payments are "Internal Transfer" and stay out of budgets [V] | Unknown |
| **Emma** | "left of" (budget remainder) and **True Balance** (account balance after recurring payments) | "left of" = total budget − committed spending − past spending; it is **not your balance** [V]. True Balance is balance-based [V] | **Custom pay period**, with a choice of what happens when payday isn't a working day [V] | Not part of "left of" [V]. Unknown for True Balance | The user is told to subtract savings from income when setting the budget [V] | Card repayments are auto-excluded from committed spending [V]. A user says card debt isn't subtracted from True Balance [U] | Unknown |
| **Actual** | To Budget | The money you have. Cards are on-budget accounts whose negative balance reduces available funds [V] | Month. You can hold income for next month [V-s] | No | Categories | Payments are transfers. A separate "debt" category tracks debt carried over [V] | No; a card's balance reduces funds [V] |
| **Monzo** | Balance in Trends, "left to spend" | Balance minus bills and direct debits [V] | "All the way to your next payday" [V] | Not documented | Pots must be included in Trends for the figure to be right [U] | Not documented | Unknown |

**The key structural finding [I]:** the market has two different kinds of indicator.

- **Plan-based "left" figures** (PocketGuard, Simplifi, Monarch Flex, Copilot, Emma "left of"). They answer "how much of my monthly plan is left?" and add expected income.
- **Balance-based figures** (Emma True Balance, Monzo Trends, YNAB and Actual by construction). They answer "how much of the money I actually have is free?"

Our Safe to Spend (STS) is **balance-based**. It also deducts goals and a card reserve, and it never adds expected income. YNAB comes closest on discipline, and Emma and Monzo come closest on the payday window. No app I studied combines all of these and publishes the formula.

---

## B.2 Findings by topic

### B.2.1 Safe-to-spend indicators
- [V] Simplifi, Emma and PocketGuard each say in their official docs that their figure is *not* your bank balance. Emma has a whole help article on "[Why is my 'left of' different from my available balance?](https://help.emma-app.com/en/article/why-is-my-left-of-different-from-my-available-balance-nklig0/)".
- [V] Simplifi shows "your average daily spending allowance", based on the money remaining and the days left ([Simplifi](https://support.simplifi.quicken.com/en/articles/3620741-using-the-spending-plan-on-the-mobile-app)). Copilot has an "ideal pace" line ([Copilot](https://intercom.help/copilotmoney/en/articles/6045480-dashboard-tab)).
- [U] Monzo users report that the projection extrapolates early-month spending into the rest of the month, which makes the figure confusing.
- [I] Our per-day STS (rounded down to the cent) matches the daily-allowance pattern. We never extrapolate spending, and that's correct.

### B.2.2 Pay-cycle budgeting
- [V] Emma lets you choose weekly, monthly, a fixed date, the last working day, and similar periods. If the date isn't a working day, you choose "before", "after" or "on the date". Early pay "will show in the period it arrives in" ([Emma](https://help.emma-app.com/en/article/what-is-a-period-in-emma-o5u7bx/)).
- [V] Monzo describes the period as running "to your next payday" ([Monzo](https://monzo.com/blog/balance-in-trends)).
- [U] Monzo users complain about figures resetting on the calendar month instead of payday ([Monzo community](https://community.monzo.com/t/what-does-left-to-spend-mean-in-the-app/107654)).
- **Unknown:** no app documents whether a bill due *on* payday counts in the old period or the new one. Emma's period "resets on" payday, so payday belongs to the new period [I].
- Irregular income has two approaches:
  - **Add expected income** (PocketGuard [V-s]; Monarch recommends expected income as the baseline [V]). A third-party review reports that the number "bounces unpredictably" for variable earners [U].
  - **Don't add it** (YNAB: budget only money you have, and build a buffer [V]).

### B.2.3 Saving ahead for bills and avoiding double counting
- [V] YNAB avoids the problem structurally: the bill and the money saved for it are the same category, with a Target.
- [V] Monarch uses Non-monthly categories with rollover (sinking funds). It also separately allocates account balances to goals and alerts you when you're over-allocated. You "can't allocate more than what's available" [V-s].
- [V] Simplifi: withdrawals from a goal for its own purpose "don't affect the plan", while withdrawals for other purposes reduce it.
- [I] The Monarch and Simplifi rules match our model independently: allocations are capped by the balance, shortfall is shown, and spending a goal's money for its purpose isn't counted twice. That supports AM-1 and R5. It doesn't prove them.

### B.2.4 Credit cards
- [V] YNAB, Actual and (per a staff reply [U]) Simplifi all treat card spending as **spent at purchase**. YNAB's "credit overspending" is explicitly money borrowed from the card company.
- [V] Every app that documents card payments treats them as transfers, not spending: Copilot, Actual, Emma, and PocketGuard [V-s].
- [U] Users report confusion and double counting:
  - **Simplifi:** an include/exclude toggle for card payments lets users count spending twice, or show more money than they have ([Simplifi community](https://community.simplifimoney.com/discussion/14171/credit-cards-and-the-spending-plan-edited)).
  - **YNAB:** the Credit Card Payment category confuses new users ([YNAB blog on its redesign](https://www.ynab.com/blog/ynab-credit-card-handling-new-improved)).
- **Credit limits:** no app I studied documents counting unused credit as spendable money.

### B.2.5 Cashback and refunds
- [V] YNAB records both cash rewards and statement credits as income (Ready to Assign). Card refunds go back to the original spending category ([rewards](https://support.ynab.com/en_us/credit-card-rewards-and-statement-credits-a-guide-ryoRzYY0q.md), [refunds](https://support.ynab.com/en_us/credit-card-refunds-and-returns-H1J7qDWkj.md)).
- [U] YNAB users say a refund counts in the month it arrives and can't be moved to an earlier month ([r/ynab](https://www.reddit.com/r/ynab/comments/1gdx4ck/)).
- [V] Copilot puts refunds in the same category as the purchase. It also recommends **changing the refund's date to the original purchase date**, so the refund lands in the earlier month ([Copilot](https://intercom.help/copilotmoney/en/articles/5325170-refund-transactions)).
- [U] Monarch users are split between recording cashback as income and as a reduction of spending. I found no official Monarch guidance.
- **Unknown** for Simplifi, PocketGuard, Emma and Monzo.

### B.2.6 Terminology
The names in use are: Ready to Assign, Available, Leftover, Left this month, Flex number, Free to Spend, "left of", True Balance, and left to spend.

- [I] Any "left/available" wording without a qualifier gets read as "my balance". That is exactly why Emma and PocketGuard publish help articles explaining the difference.
- [I] Names that work tie the figure to a question or a date ("to your next payday"). YNAB's "Ready to Assign" names an action, not an amount you can spend.

### B.2.7 Recurring complaints
1. **"It says I have money when I don't", or the reverse.** Simplifi has a thread with that title; I couldn't read the thread itself because it requires sign-in [U]. PocketGuard has an official FAQ on a negative Leftover while there's money in the account [V-s].
2. **Card payments and transfers counted twice** because of a toggle (Simplifi) [U].
3. **Period mismatches.**
   - Emma: a weekly period with monthly budgets produced a wrong figure, and staff confirmed you have to set all budgets weekly [U].
   - Monzo: one screen used payday and another used the calendar month [U].
4. **Expected payments not cleared when the real one arrives.** Emma says removal "won't always happen immediately". It also says a payment can fail to match when the amount or date differs [V] ([Emma](https://help.emma-app.com/en/article/learn-committed-spending-1cg2t8v/)).
5. **Surprising projections** from extrapolated spending (Monzo) [U].
6. **Opaque learning periods and heavy setup.** Monzo needs a first month to "learn" [U]. Copilot reviews mention budget estimates above the user's income [U].

---

## B.3 What to copy and what not to copy

**Relevant and consistent with our rules:**
- Payday-bounded window, including a non-working-day adjustment (Emma, Monzo).
- Card spending counted at purchase; card payments are always transfers (YNAB, Actual).
- Goal allocations capped by the balance, with a visible shortfall (Monarch).
- A daily allowance.
- An official "why this differs from your balance" explainer.

**Do not copy:**
- Adding expected income into the indicator (PocketGuard, Monarch, Simplifi). It breaks our rule that planned ≠ actual.
- Extrapolating spending into the figure (Monzo).
- A toggle to include or exclude card payments (Simplifi). It is a double-counting trap; in our ledger a payment is always a transfer.
- Moving refunds back to the purchase date (Copilot). It rewrites months that are already closed and silently changes past reports.
- Counting unused credit limit as spendable.
- Opaque "learning" figures.

---

## B.4 Reassessment of my six proposals

**Accounting correctness** is whether the proposal is required by our invariants and golden tests. **Market convention** is what competitors do. I didn't change any accounting rule because of what competitors do.

**I-2 (window ends before payday; option c).**
- Accounting: either including or excluding payday is consistent, as long as income that hasn't arrived is never added. Option (c) also covers the real risk: a bill taken before the salary lands on payday.
- Market: payday-bounded windows exist (Emma, Monzo). How a bill on payday itself is handled isn't documented anywhere. Emma's reset on payday fits with excluding it.
- **Verdict: keep unchanged.** New gap found: we have no non-working-day adjustment for income rules (see SC-1).

**I-3 (R5: bills linked to a goal; Must).**
- Accounting: **required.** Without it, a bill in planned outflows and its goal allocation are both deducted, which counts the same money twice. That violates our invariants.
- Market: YNAB avoids the problem structurally. Simplifi has a similar exception for goal withdrawals.
- **Verdict: keep as Must.** Change only the presentation: offer it as a "Save for a bill" goal, so the user sees one object (SC-3).

**I-5 (reliable income flag).**
- Accounting: the flag only sets the window end (H) and never adds money. If it's wrong, the worst case is a window of the wrong length.
- Market: no app has a "reliability" flag. The market equivalent is a **declared payday**.
- **Verdict: logic stays, the proposal is revised (SC-2):**
  - Rename it to a payday or salary marker.
  - Allow it on variable-amount income. Only the date drives H; matching would use date, account and payer, with the amount not required. Note that this affects the §9 matching rules.
  - Demote the automatic flag and un-flag suggestions to Should. They have no precedent and add complexity.
  - Keep the onboarding question as Must.

**I-8 (cashback as income).**
- Accounting: both treatments are defensible and neither counts anything twice. Income treatment slightly inflates Income and Net Result; treating it as a reduction lowers Expenses.
- Market: YNAB officially uses income [V]; others vary.
- **Verdict: keep the default.** Add a documented option to record cashback in an expense category as a negative expense, which the ledger already supports for refunds (SC-4). Refunds stay as in I-9.

**I-11 (naming).**
- Accounting: not affected.
- Market: names that read as "your balance" cause the most documented confusion.
- **Verdict: keep "Приходи − Разходи" and "Промяна в наличностите".** Two additions (SC-5):
  - The STS label must always show its window ("until 30 Nov") and link to a "why it differs from your balance" breakdown.
  - Words used for budget remainders must never reuse the STS term from D-2.

**I-12 (projection deducts the reserved card balance on day 0).**
- Accounting: **required** for consistency between the projection and STS.
- Market: the most rigorous apps (YNAB, Actual) count card spending as spent at once. Emma's True Balance reportedly doesn't deduct card debt, and users complain about it [U].
- **Verdict: keep.**

---

## B.5 Recommendations for our product
1. Keep the balance-based STS. It's the stricter of the two market approaches, and its complaint profile is better: the reported confusion clusters around figures that ignore balances or add expected income.
2. Make the difference from the bank balance explicit in the UI: a breakdown, the window date, and a short explainer.
3. Add payday adjustment for non-working days (weekends in the MVP; public holidays later).
4. Present R5 as "Save for a bill".
5. Adopt the "do not copy" list above as explicit non-goals in the spec.

## B.6 Decisions that need your approval
- **The 8 earlier approvals:**
  1. I-1 (AM-1 with rule G-P4)
  2. I-2 option (c)
  3. I-3 (R5 as Must)
  4. I-4 and I-5
  5. I-6 to I-10
  6. I-11 and I-12
  7. I-14 cut list
  8. AM-3 to AM-5
- **New:**
  - **N1 (SC-1):** non-working-day adjustment for income rules. Should is my default; make it Must if many target users are paid on the last working day.
  - **N2 (SC-2):** the revised I-5: rename, allow variable amounts, demote the heuristics.
  - **N3 (SC-3):** the "Save for a bill" presentation.
  - **N4 (SC-4):** the option to record cashback as a spending reduction.
  - **N5:** adopting the non-goals list. This is a confirmation rather than a design choice.

## B.7 Changes needed to the Stage 1 specification
- **SC-1:** income rules get a non-working-day setting (before / after / on the date). It changes how H is computed. Public holidays are deferred.
- **SC-2:** rewrite I-5 as above, and update the §9 matching rules for variable-amount payday income.
- **SC-3:** a UI-level "Save for a bill" goal that creates and links the planned payment. The R5 logic is unchanged.
- **SC-4:** document cashback reclassification.
- **SC-5:** STS explainer copy and naming rules.
- **SC-6:** add a non-goals section.
- **New golden tests:**
  - GT-62: payday falls on a Saturday and is moved to Friday.
  - GT-63: cashback recorded as income versus as a spending reduction.
  - GT-64: payday income with a variable amount, matched by date.
- **No accounting rule, formula or existing golden number changes.**

## B.8 Can Part 4 proceed?
**Yes.** The research found no unresolved critical financial logic and nothing that contradicts the ledger or the STS rules. Part 4 needs only your answers to the 8 earlier approvals. N1–N5 can go into the Open Decisions Register as non-blocking with my defaults. N2 is the exception: it changes the §9 matching rules, so I'll write §9 with my default and mark it pending your approval.

I can also turn this study into a shareable page if you want it outside the chat.

---

**Sources**
- **YNAB:**
  - [Glossary](https://support.ynab.com/en_us/ynab-glossary-a-guide-BJd80SORq.md)
  - [Handling credit cards](https://support.ynab.com/en_us/handling-credit-cards-overview-ry7cNub1s.md)
  - [Rewards and statement credits](https://support.ynab.com/en_us/credit-card-rewards-and-statement-credits-a-guide-ryoRzYY0q.md)
  - [Card refunds](https://support.ynab.com/en_us/credit-card-refunds-and-returns-H1J7qDWkj.md)
  - [Irregular income guide](https://www.ynab.com/guide/irregular-income)
  - [Credit card redesign](https://www.ynab.com/blog/ynab-credit-card-handling-new-improved)
  - [r/ynab thread on refunds](https://www.reddit.com/r/ynab/comments/1gdx4ck/)
- **PocketGuard:** [Leftover help, read via search excerpts](https://pocketguard.com/help/leftover)
- **Simplifi:**
  - [Spending Plan help](https://support.simplifi.quicken.com/en/articles/3620741-using-the-spending-plan-on-the-mobile-app)
  - [Community: credit cards and the Spending Plan](https://community.simplifimoney.com/discussion/14171/credit-cards-and-the-spending-plan-edited)
  - [Community: checking account balance](https://community.simplifimoney.com/discussion/15632/spending-plan-how-to-include-checking-account-balance)
- **Monarch:**
  - [Flex budgeting](https://www.monarch.com/blog/flex-budgeting-simplify-your-spending-with-just-one-number)
  - [Budget help](https://help.monarch.com/hc/en-us/articles/360048883631-Creating-Your-Budget-in-Monarch)
  - [Goals 3.0](https://help.monarch.com/hc/en-us/articles/44373110771860-Introducing-Goals-3-0)
  - [Moving funds in and out of goals](https://help.monarch.com/hc/en-us/articles/46420712538260-Moving-Funds-In-and-Out-of-Goals)
- **Copilot:**
  - [Dashboard](https://intercom.help/copilotmoney/en/articles/6045480-dashboard-tab)
  - [Transaction types](https://intercom.help/copilotmoney/en/articles/3971267-transaction-types)
  - [Refunds](https://intercom.help/copilotmoney/en/articles/5325170-refund-transactions)
  - [App reviews](https://justuseapp.com/en/app/1447330651/copilot-the-smart-money-app/reviews)
- **Emma:**
  - ["left of" vs balance](https://help.emma-app.com/en/article/why-is-my-left-of-different-from-my-available-balance-nklig0/)
  - [Budget period](https://help.emma-app.com/en/article/what-is-a-period-in-emma-o5u7bx/)
  - [Committed spending](https://help.emma-app.com/en/article/learn-committed-spending-1cg2t8v/)
  - [True Balance](https://help.emma-app.com/en/article/true-balance-l8r139/)
- **Actual:**
  - [Credit cards](https://actualbudget.org/docs/budgeting/credit-cards)
  - [Carrying debt](https://actualbudget.org/docs/budgeting/credit-cards/carrying-debt)
  - [How it works](https://actualbudget.org/docs/budgeting/how-it-works)
- **Monzo:**
  - [Balance in Trends](https://monzo.com/blog/balance-in-trends)
  - [Community: "left to spend"](https://community.monzo.com/t/what-does-left-to-spend-mean-in-the-app/107654)
