'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { allocateByWeights } from '@fintrack/domain';
import { ApiProblem, errorMessage } from '@/lib/api';
import { formatMoney, parseUserAmount } from '@/lib/money';
import { active, todayLocal, type Account, type Category, type Transaction } from '@/lib/use-api';

export type FormKind = 'expense' | 'income' | 'transfer' | 'refund' | 'debt_payment';

interface Line {
  target: string;
  amount: string;
  memo: string;
}

export interface FormValues {
  kind: FormKind;
  total: string;
  accountId: string;
  /** Destination of a transfer, or the debt of a debt payment. */
  toId: string;
  lines: Line[];
  feeAmount: string;
  feeCategory: string;
  interestAmount: string;
  interestCategory: string;
  date: string;
  description: string;
  memo: string;
  payee: string;
  refundOfId: string | null;
}

export interface PayeeOption {
  name: string;
  defaultCategoryId: string | null;
  archived: boolean;
}

/** "45.60" for 4560: an exact decimal string for a field, without floating point. */
export function editableAmount(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const emptyLine = (target = ''): Line => ({ target, amount: '', memo: '' });

/** Fills the form from a stored transaction, or returns null for a shape it can't show (T-53). */
export function valuesFrom(tx: Transaction, accounts: Map<string, Account>, categories: Map<string, Category>): FormValues | null {
  const own = tx.lines.filter((line) => accounts.has(line.ledgerAccountId));
  const cats = tx.lines.filter((line) => categories.has(line.ledgerAccountId));
  const base = {
    feeAmount: '',
    feeCategory: '',
    interestAmount: '',
    interestCategory: '',
    date: tx.date,
    description: tx.description ?? '',
    memo: tx.memo ?? '',
    payee: tx.payee ?? '',
    refundOfId: tx.refundOfId ?? null,
    toId: '',
  };
  const lineFrom = (line: Transaction['lines'][number], minor: number): Line => ({ target: line.ledgerAccountId, amount: editableAmount(minor), memo: line.memo ?? '' });
  switch (tx.kind) {
    case 'expense':
    case 'income':
    case 'refund': {
      if (own.length !== 1) return null;
      const lines = cats.map((line) => {
        if (tx.kind === 'expense') return lineFrom(line, line.amount_minor);
        if (tx.kind === 'income') return lineFrom(line, -line.amount_minor);
        return lineFrom(line, Math.abs(line.amount_minor));
      });
      return { ...base, kind: tx.kind, total: editableAmount(Math.abs(own[0]!.amount_minor)), accountId: own[0]!.ledgerAccountId, lines };
    }
    case 'split': {
      // An expense with part of it going to an account. Other mixes are voided and entered again.
      const paying = own.filter((line) => line.amount_minor < 0);
      if (paying.length !== 1 || tx.lines.some((line) => line !== paying[0] && line.amount_minor < 0)) return null;
      const lines = tx.lines.filter((line) => line !== paying[0]).map((line) => lineFrom(line, line.amount_minor));
      return { ...base, kind: 'expense', total: editableAmount(-paying[0]!.amount_minor), accountId: paying[0]!.ledgerAccountId, lines };
    }
    case 'transfer': {
      const from = own.find((line) => line.amount_minor < 0);
      const to = own.find((line) => line.amount_minor > 0);
      if (!from || !to || own.length !== 2 || cats.length > 1) return null;
      const fee = cats[0];
      return { ...base, kind: 'transfer', total: editableAmount(to.amount_minor), accountId: from.ledgerAccountId, toId: to.ledgerAccountId, lines: [], feeAmount: fee ? editableAmount(fee.amount_minor) : '', feeCategory: fee?.ledgerAccountId ?? '' };
    }
    case 'debt_payment': {
      const from = own.find((line) => line.amount_minor < 0);
      const to = own.find((line) => line.amount_minor > 0);
      if (!from || !to || cats.length > 2) return null;
      return {
        ...base,
        kind: 'debt_payment',
        total: editableAmount(to.amount_minor),
        accountId: from.ledgerAccountId,
        toId: to.ledgerAccountId,
        lines: [],
        interestAmount: cats[0] ? editableAmount(cats[0].amount_minor) : '',
        interestCategory: cats[0]?.ledgerAccountId ?? '',
        feeAmount: cats[1] ? editableAmount(cats[1].amount_minor) : '',
        feeCategory: cats[1]?.ledgerAccountId ?? '',
      };
    }
    default:
      return null;
  }
}

/**
 * Entering or editing any transaction a person records by hand (FR-04, FR-06). It sends an
 * intention; the server builds and checks the postings. The running remainder here is only a
 * guide for typing, and the server checks everything again.
 */
export function TransactionForm({
  accounts,
  categories,
  currency,
  payees = [],
  initial,
  lockKind,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  accounts: Account[];
  categories: Category[];
  currency: string;
  payees?: PayeeOption[];
  initial?: Partial<FormValues> | undefined;
  lockKind?: boolean;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>, kind: FormKind) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useTranslations('newTransaction');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const usable = active(accounts);
  const [values, setValues] = useState<FormValues>({
    kind: 'expense',
    total: '',
    accountId: usable[0]?.id ?? '',
    toId: '',
    lines: [emptyLine()],
    feeAmount: '',
    feeCategory: '',
    interestAmount: '',
    interestCategory: '',
    date: todayLocal(),
    description: '',
    memo: '',
    payee: '',
    refundOfId: null,
    ...initial,
  });
  const [percentMode, setPercentMode] = useState(false);
  const [percents, setPercents] = useState<string[]>([]);
  const [exceeds, setExceeds] = useState<{ refund: number; original: number } | null>(null);
  const [confirmExceeds, setConfirmExceeds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<FormValues>) => setValues((current) => ({ ...current, ...patch }));
  const setLine = (index: number, patch: Partial<Line>) => set({ lines: values.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });

  const byId = new Map(categories.map((category) => [category.id, category]));
  const label = (category: Category) => {
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };
  const usableCategories = active(categories);
  const ofKind = (kind: 'income' | 'expense') => usableCategories.filter((category) => category.kind === kind);
  const debts = usable.filter((account) => account.class === 'liability');
  const { kind } = values;
  const splitting = values.lines.length > 1;
  const isLineKind = kind === 'expense' || kind === 'income' || kind === 'refund';
  const parsedTotal = parseUserAmount(values.total);
  // Keeps each category choice valid for the kind on screen.
  /** Naming a known payee fills in its usual category, if the user hasn't chosen one (BR-05.6). */
  function choosePayee(name: string) {
    const known = payees.find((payee) => payee.name.toLowerCase() === name.trim().toLowerCase());
    const category = known?.defaultCategoryId ? byId.get(known.defaultCategoryId) : undefined;
    const fits = category && !category.archived && (kind === 'refund' || category.kind === (kind === 'income' ? 'income' : 'expense'));
    if (fits && values.lines.length === 1 && !values.lines[0]!.target) set({ payee: name, lines: [{ ...values.lines[0]!, target: category.id }] });
    else set({ payee: name });
  }

  const firstTarget = kind === 'income' ? ofKind('income')[0]?.id : ofKind('expense')[0]?.id;
  const shownTarget = (line: Line) => line.target || firstTarget || '';

  /** In income, an expense category is a deduction, so it counts against what was received. */
  const signedLine = (line: Line): number | null => {
    const amount = parseUserAmount(line.amount);
    if (amount === null) return null;
    return kind === 'income' && byId.get(line.target)?.kind === 'expense' ? -Math.abs(amount) : amount;
  };

  function lineAmounts(): number[] | null {
    if (!percentMode) return values.lines.map(signedLine) as number[];
    const weights = percents.map((value) => Number(value.replace(',', '.')));
    if (parsedTotal === null || parsedTotal <= 0 || weights.some((w) => !(w > 0)) || Math.abs(weights.reduce((a, b) => a + b, 0) - 100) > 1e-9) return null;
    return allocateByWeights(parsedTotal, weights.map((w) => Math.round(w * 1_000_000)));
  }
  const amounts = splitting ? lineAmounts() : null;
  const assigned = amounts && amounts.every((a) => a !== null) ? amounts.reduce((sum, a) => sum + a, 0) : null;
  const remainder = parsedTotal !== null && assigned !== null ? parsedTotal - assigned : null;

  function startSplit() {
    const firstAmount = values.lines[0]?.amount || values.total;
    set({ lines: [{ ...values.lines[0]!, amount: firstAmount }, emptyLine()] });
  }

  function splitEqually() {
    if (parsedTotal === null || parsedTotal <= 0) return setError(tErrors('invalidAmount'));
    setPercentMode(false);
    const parts = allocateByWeights(parsedTotal, values.lines.map(() => 1));
    set({ lines: values.lines.map((line, index) => ({ ...line, amount: editableAmount(parts[index]!) })) });
  }

  const bankFees = () => values.feeCategory || ofKind('expense').find((c) => c.name === 'Bank fees')?.id || ofKind('expense')[0]?.id || '';
  const interestFees = () => values.interestCategory || ofKind('expense').find((c) => c.name === 'Interest and fees')?.id || ofKind('expense')[0]?.id || '';

  function intention(): Record<string, unknown> | string {
    const chosen = values.lines.map((line) => ({ ...line, target: shownTarget(line) }));
    const total = parsedTotal;
    if (total === null || total <= 0) return tErrors('invalidAmount');
    const text = {
      date: values.date,
      ...(values.description.trim() ? { description: values.description.trim() } : {}),
      ...(values.memo.trim() ? { memo: values.memo.trim() } : {}),
      ...(values.payee.trim() ? { payee: values.payee.trim() } : {}),
    };
    const optional = (raw: string) => (raw.trim() === '' ? 0 : parseUserAmount(raw));

    if (kind === 'transfer') {
      const fee = optional(values.feeAmount);
      if (fee === null || fee < 0) return tErrors('invalidAmount');
      return { kind, fromAccountId: values.accountId, toAccountId: values.toId, amount_minor: total, ...(fee > 0 ? { fee: { categoryId: bankFees(), amount_minor: fee } } : {}), ...text };
    }
    if (kind === 'debt_payment') {
      const interest = optional(values.interestAmount);
      const fee = optional(values.feeAmount);
      if (interest === null || fee === null || interest < 0 || fee < 0) return tErrors('invalidAmount');
      const extras = [
        ...(interest > 0 ? [{ categoryId: interestFees(), amount_minor: interest }] : []),
        ...(fee > 0 ? [{ categoryId: bankFees(), amount_minor: fee }] : []),
      ];
      return { kind, fromAccountId: values.accountId, liabilityAccountId: values.toId, principal_minor: total, ...(extras.length ? { extras } : {}), ...text };
    }

    const lineValues = splitting ? amounts : [total];
    if (!lineValues || lineValues.some((a) => a === null || a === 0)) return percentMode ? t('percentsNotHundred') : tErrors('invalidAmount');
    if (splitting && remainder !== 0) return t('remainder', { amount: formatMoney(Math.abs(remainder ?? 0), currency) });
    const memoOf = (line: Line) => (line.memo.trim() ? { memo: line.memo.trim() } : {});

    // Part of an expense going to one of the user's accounts is a general split (BR-06.1).
    if (kind === 'expense' && chosen.some((line) => usable.some((account) => account.id === line.target))) {
      return {
        kind: 'split',
        lines: [
          { ledgerAccountId: values.accountId, amount_minor: -total },
          ...chosen.map((line, index) => ({ ledgerAccountId: line.target, amount_minor: lineValues[index]!, ...memoOf(line) })),
        ],
        ...text,
      };
    }
    const lines = chosen.map((line, index) => {
      const amount = lineValues[index]!;
      const base = { categoryId: line.target, amount_minor: Math.abs(amount), ...memoOf(line) };
      if (kind === 'expense' && amount < 0) return { ...base, mark: 'discount' };
      if (kind === 'income' && byId.get(line.target)?.kind === 'expense') return { ...base, mark: 'deduction' };
      return base;
    });
    return {
      kind,
      accountId: values.accountId,
      lines,
      ...(kind === 'refund' && values.refundOfId ? { refundOfId: values.refundOfId } : {}),
      ...(kind === 'refund' && confirmExceeds ? { confirmExceedsOriginal: true } : {}),
      ...text,
    };
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = intention();
    if (typeof body === 'string') return setError(body);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body, kind);
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.code === 'REFUND_EXCEEDS_ORIGINAL') {
        const details = problem.details as { refund_minor: number; original_minor: number };
        setExceeds({ refund: details.refund_minor, original: details.original_minor });
      } else {
        setError(errorMessage(problem, tErrors));
      }
      setBusy(false);
    }
  }

  const accountOptions = (list: Account[]) =>
    list.map((account) => (
      <option key={account.id} value={account.id}>
        {account.name}
      </option>
    ));
  const categoryOptions = (list: Category[]) =>
    list.map((category) => (
      <option key={category.id} value={category.id}>
        {label(category)}
      </option>
    ));
  /** What a line may post to, given the kind. Refunds reverse either kind of category. */
  const targetOptions =
    kind === 'expense' ? (
      <>
        <optgroup label={t('categoriesGroup')}>{categoryOptions(ofKind('expense'))}</optgroup>
        <optgroup label={t('accountsGroup')}>{accountOptions(usable.filter((account) => account.id !== values.accountId))}</optgroup>
      </>
    ) : kind === 'income' ? (
      <>
        {categoryOptions(ofKind('income'))}
        {splitting && categoryOptions(ofKind('expense'))}
      </>
    ) : (
      categoryOptions(usableCategories)
    );

  function changeKind(next: FormKind) {
    const defaults: Partial<FormValues> = { kind: next };
    if (next === 'debt_payment') defaults.toId = values.toId && debts.some((d) => d.id === values.toId) ? values.toId : debts[0]?.id ?? '';
    if (next === 'transfer') defaults.toId = usable.find((account) => account.id !== values.accountId)?.id ?? '';
    if (next === 'transfer' || next === 'debt_payment') {
      defaults.feeCategory = values.feeCategory || ofKind('expense').find((c) => c.name === 'Bank fees')?.id || ofKind('expense')[0]?.id || '';
      defaults.interestCategory = values.interestCategory || ofKind('expense').find((c) => c.name === 'Interest and fees')?.id || ofKind('expense')[0]?.id || '';
    }
    // A category that doesn't fit the new kind is dropped; refunds accept either kind.
    const fits = (line: Line) => !line.target || next === 'refund' || byId.get(line.target)?.kind === (next === 'income' ? 'income' : 'expense');
    defaults.lines = values.lines.map((line) => (fits(line) ? line : { ...line, target: '' }));
    if (defaults.lines.length === 0) defaults.lines = [emptyLine()];
    set(defaults);
    setPercentMode(false);
  }

  return (
    <form className="card" onSubmit={submit}>
      {!lockKind && (
        <div className="segmented segmented-wrap" role="radiogroup" aria-label={t('title')}>
          {(['expense', 'income', 'transfer', 'refund', 'debt_payment'] as const).map((value) => (
            <label key={value}>
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => changeKind(value)} /> {t(value)}
            </label>
          ))}
        </div>
      )}

      <div className="field">
        <label htmlFor="amount">{kind === 'debt_payment' ? t('principal') : splitting ? t('total') : t('amount')}</label>
        <input id="amount" type="text" inputMode="decimal" placeholder="0.00" className="amount-input" required autoFocus value={values.total} onChange={(event) => set({ total: event.target.value })} />
      </div>

      {kind === 'transfer' || kind === 'debt_payment' ? (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="from">{t('from')}</label>
            <select id="from" value={values.accountId} onChange={(event) => set({ accountId: event.target.value })}>
              {accountOptions(usable)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="to">{kind === 'transfer' ? t('to') : t('liability')}</label>
            <select id="to" value={values.toId} onChange={(event) => set({ toId: event.target.value })}>
              {accountOptions(kind === 'transfer' ? usable : debts)}
            </select>
          </div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="account">{t('account')}</label>
          <select id="account" value={values.accountId} onChange={(event) => set({ accountId: event.target.value })}>
            {accountOptions(usable)}
          </select>
        </div>
      )}
      {kind === 'debt_payment' && debts.length === 0 && <p className="notice notice-info small">{t('needDebt')}</p>}
      {kind === 'transfer' && usable.length < 2 && <p className="notice notice-info small">{t('needTwoAccounts')}</p>}

      {isLineKind &&
        (splitting ? (
          <fieldset className="choice">
            <legend>{t('split')}</legend>
            {values.lines.map((line, index) => {
              const number = index + 1;
              return (
                <div className="split-line" key={index}>
                  <div className="field">
                    <label htmlFor={`line-target-${index}`}>{t('lineTarget', { number })}</label>
                    <select id={`line-target-${index}`} value={shownTarget(line)} onChange={(event) => setLine(index, { target: event.target.value })}>
                      {targetOptions}
                    </select>
                  </div>
                  <div className="grid-2">
                    {percentMode ? (
                      <div className="field">
                        <label htmlFor={`line-percent-${index}`}>{t('linePercent', { number })}</label>
                        <input
                          id={`line-percent-${index}`}
                          type="text"
                          inputMode="decimal"
                          value={percents[index] ?? ''}
                          onChange={(event) => setPercents(values.lines.map((_, i) => (i === index ? event.target.value : percents[i] ?? '')))}
                        />
                      </div>
                    ) : (
                      <div className="field">
                        <label htmlFor={`line-amount-${index}`}>{t('lineAmount', { number })}</label>
                        <input id={`line-amount-${index}`} type="text" inputMode="decimal" value={line.amount} onChange={(event) => setLine(index, { amount: event.target.value })} />
                      </div>
                    )}
                    <div className="field">
                      <label htmlFor={`line-note-${index}`}>{t('lineNote', { number })}</label>
                      <input id={`line-note-${index}`} type="text" maxLength={500} value={line.memo} onChange={(event) => setLine(index, { memo: event.target.value })} />
                    </div>
                  </div>
                  <button className="btn btn-ghost" type="button" onClick={() => set({ lines: values.lines.filter((_, i) => i !== index) })}>
                    {t('removeLine', { number })}
                  </button>
                </div>
              );
            })}
            <div className="actions">
              <button className="btn" type="button" onClick={() => set({ lines: [...values.lines, emptyLine()] })}>
                {t('addLine')}
              </button>
              <button className="btn" type="button" onClick={splitEqually}>
                {t('equal')}
              </button>
              <button className="btn" type="button" onClick={() => setPercentMode(!percentMode)}>
                {percentMode ? t('byAmount') : t('byPercent')}
              </button>
            </div>
            <p className={`small ${remainder === 0 ? 'muted' : ''}`} role="status" aria-live="polite">
              {remainder === 0 ? t('assigned') : t('remainder', { amount: remainder === null ? '—' : `${remainder < 0 ? '−' : ''}${formatMoney(Math.abs(remainder), currency)}` })}
            </p>
            {kind !== 'refund' && <p className="hint">{t('discountHint')}</p>}
          </fieldset>
        ) : (
          <>
            <div className="field">
              <label htmlFor="category">{t('category')}</label>
              <select id="category" value={shownTarget(values.lines[0] ?? emptyLine())} onChange={(event) => setLine(0, { target: event.target.value })}>
                {kind === 'income' ? categoryOptions(ofKind('income')) : kind === 'refund' ? categoryOptions(usableCategories) : categoryOptions(ofKind('expense'))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="line-note-only">{t('memo')}</label>
              <input id="line-note-only" type="text" maxLength={1000} value={values.memo} onChange={(event) => set({ memo: event.target.value })} />
            </div>
            <button className="btn btn-ghost" type="button" onClick={startSplit}>
              {t('split')}
            </button>
          </>
        ))}

      {kind === 'debt_payment' && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="interest">{t('interest')}</label>
            <input id="interest" type="text" inputMode="decimal" value={values.interestAmount} onChange={(event) => set({ interestAmount: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="interest-category">{t('interestCategory')}</label>
            <select id="interest-category" value={interestFees()} onChange={(event) => set({ interestCategory: event.target.value })}>
              {categoryOptions(ofKind('expense'))}
            </select>
          </div>
        </div>
      )}
      {(kind === 'transfer' || kind === 'debt_payment') && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="fee">{t('fee')}</label>
            <input id="fee" type="text" inputMode="decimal" value={values.feeAmount} onChange={(event) => set({ feeAmount: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="fee-category">{t('feeCategory')}</label>
            <select id="fee-category" value={bankFees()} onChange={(event) => set({ feeCategory: event.target.value })}>
              {categoryOptions(ofKind('expense'))}
            </select>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="date">{t('date')}</label>
        <input id="date" type="date" value={values.date} max={todayLocal()} required onChange={(event) => set({ date: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="payee">{t('payee')}</label>
        <input id="payee" type="text" maxLength={100} list="payee-options" autoComplete="off" value={values.payee} onChange={(event) => choosePayee(event.target.value)} />
        <datalist id="payee-options">
          {payees.filter((payee) => !payee.archived).map((payee) => (
            <option key={payee.name} value={payee.name} />
          ))}
        </datalist>
      </div>
      <div className="field">
        <label htmlFor="description">{t('description')}</label>
        <input id="description" type="text" maxLength={500} value={values.description} onChange={(event) => set({ description: event.target.value })} />
      </div>
      {(!isLineKind || splitting) && (
        <div className="field">
          <label htmlFor="memo">{t('memo')}</label>
          <input id="memo" type="text" maxLength={1000} value={values.memo} onChange={(event) => set({ memo: event.target.value })} />
        </div>
      )}

      {exceeds && (
        <div className="notice notice-warning small" role="alert">
          <p>{t('exceedsTitle', { refund: formatMoney(exceeds.refund, currency), original: formatMoney(exceeds.original, currency) })}</p>
          <label className="check">
            <input type="checkbox" checked={confirmExceeds} onChange={(event) => setConfirmExceeds(event.target.checked)} />
            <span>{t('exceedsConfirm')}</span>
          </label>
        </div>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={busy || (exceeds !== null && !confirmExceeds)}>
          {busy ? tApp('loading') : submitLabel}
        </button>
        {onCancel && (
          <button className="btn" type="button" onClick={onCancel}>
            {tApp('cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
