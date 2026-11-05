'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { editableAmount } from '@/components/TransactionForm';
import { parseUserAmount } from '@/lib/money';
import type { Goal, Rule } from '@/lib/plan';
import { todayLocal, type Account, type Category } from '@/lib/use-api';

type Kind = Rule['kind'];
const KINDS: Kind[] = ['expense', 'income', 'transfer', 'debt_payment'];
const FREQUENCIES = ['monthly_day', 'monthly_last', 'weekly', 'every_n_weeks', 'every_n_months', 'yearly', 'once'];
const NEEDS_INTERVAL = new Set(['every_n_weeks', 'every_n_months']);

/** A rule or a one-off planned item (BR-08.1). The server checks the template; this only collects it. */
export function RuleForm({
  accounts,
  categories,
  goals,
  rule,
  payday = false,
  busy,
  onSave,
}: {
  accounts: Account[];
  categories: Category[];
  goals: Goal[];
  rule?: Rule | undefined;
  payday?: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const t = useTranslations('rules');
  const liabilities = accounts.filter((account) => account.class === 'liability');
  const [kind, setKind] = useState<Kind>(rule?.kind ?? (payday ? 'income' : 'expense'));
  const [frequency, setFrequency] = useState(rule?.frequency ?? 'monthly_day');
  const [isPayday, setIsPayday] = useState(rule?.isPayday ?? payday);
  const [accountId, setAccountId] = useState(rule?.accountId ?? accounts[0]?.id ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const others = accounts.filter((account) => account.id !== accountId);
  const label = (category: Category) => {
    const parent = category.parentId ? categories.find((other) => other.id === category.parentId) : undefined;
    return parent ? `${parent.name} › ${category.name}` : category.name;
  };
  const inKind = categories.filter((category) => category.kind === (kind === 'income' ? 'income' : 'expense') && !category.archived);
  const firstLine = rule?.lines[0];
  const sameShape = rule?.kind === kind;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = parseUserAmount(String(form.get('amount') ?? ''));
    const invalid = amount === null || amount <= 0;
    if (invalid) return setProblem(t('badAmount'));
    const interest = kind === 'debt_payment' && String(form.get('interest') ?? '').trim() ? parseUserAmount(String(form.get('interest'))) : 0;
    if (interest === null || interest < 0) return setProblem(t('badAmount'));
    const optional = (name: string) => {
      const text = String(form.get(name) ?? '').trim();
      return text ? parseUserAmount(text) : null;
    };
    const min = optional('min');
    const max = optional('max');
    const counterpart = String(form.get('counterpart') ?? '');
    const interestCategory = String(form.get('interestCategory') ?? '');
    const lines =
      kind === 'debt_payment'
        ? [{ ledgerAccountId: counterpart, amount_minor: amount }, ...(interest > 0 ? [{ ledgerAccountId: interestCategory, amount_minor: interest }] : [])]
        : [{ ledgerAccountId: counterpart, amount_minor: amount }];
    if (!counterpart) return setProblem(t('chooseTarget'));
    setProblem(null);
    const interval = NEEDS_INTERVAL.has(frequency) ? Number(form.get('interval') || 1) : 1;
    const startDate = String(form.get('startDate'));
    const goalId = String(form.get('goalId') ?? '');
    onSave({
      name: String(form.get('name') ?? '').trim(),
      kind,
      amountType: form.get('estimated') === 'on' ? 'estimated' : 'fixed',
      accountId,
      lines,
      frequency,
      interval,
      startDate,
      nonWorkingDay: String(form.get('nonWorkingDay') ?? 'on_date'),
      isPayday: kind === 'income' && isPayday,
      ...(kind === 'income' && isPayday ? { payer: String(form.get('payer') ?? '').trim() } : {}),
      ...(min !== null ? { expectedMin_minor: min } : {}),
      ...(max !== null ? { expectedMax_minor: max } : {}),
      ...(String(form.get('endDate') ?? '') ? { endDate: String(form.get('endDate')) } : {}),
      ...(rule ? { goalId: goalId || null } : goalId ? { goalId } : {}),
      ...(rule ? { effectiveFrom: String(form.get('effectiveFrom') || todayLocal()) } : {}),
    });
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="field">
        <label htmlFor="name">{t('name')}</label>
        <input id="name" name="name" type="text" maxLength={100} defaultValue={rule?.name ?? (payday ? t('salaryName') : '')} required />
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 500, marginBottom: '0.35rem' }}>{t('kind')}</legend>
        <div className="segmented segmented-wrap">
          {KINDS.map((option) => (
            <label key={option}>
              <input type="radio" name="kind" checked={kind === option} onChange={() => setKind(option)} /> {t(`kinds.${option}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="account">{kind === 'income' ? t('intoAccount') : t('fromAccount')}</label>
          <select id="account" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="counterpart">{kind === 'transfer' ? t('toAccount') : kind === 'debt_payment' ? t('debtAccount') : t('category')}</label>
          <select id="counterpart" name="counterpart" key={kind} defaultValue={sameShape ? firstLine?.ledgerAccountId : undefined} required>
            {kind === 'transfer' &&
              others.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            {kind === 'debt_payment' &&
              liabilities.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            {(kind === 'expense' || kind === 'income') &&
              inKind.map((category) => (
                <option key={category.id} value={category.id}>
                  {label(category)}
                </option>
              ))}
          </select>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="amount">{kind === 'debt_payment' ? t('principal') : t('amount')}</label>
          <input id="amount" name="amount" type="text" inputMode="decimal" defaultValue={sameShape && firstLine ? editableAmount(firstLine.amount_minor) : ''} required />
        </div>
        {kind === 'debt_payment' && (
          <div className="field">
            <label htmlFor="interest">{t('interest')}</label>
            <input id="interest" name="interest" type="text" inputMode="decimal" defaultValue={sameShape && rule?.lines[1] ? editableAmount(rule.lines[1].amount_minor) : ''} />
          </div>
        )}
      </div>
      {kind === 'debt_payment' && (
        <div className="field">
          <label htmlFor="interestCategory">{t('interestCategory')}</label>
          <select id="interestCategory" name="interestCategory" defaultValue={rule?.lines[1]?.ledgerAccountId ?? categories.find((category) => /^interest/i.test(category.name) && category.kind === 'expense')?.id}>
            {categories
              .filter((category) => category.kind === 'expense' && !category.archived)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {label(category)}
                </option>
              ))}
          </select>
        </div>
      )}
      <div className="grid-2">
        <div className="field">
          <label htmlFor="frequency">{t('frequency')}</label>
          <select id="frequency" value={frequency} onChange={(event) => setFrequency(event.target.value)}>
            {FREQUENCIES.map((option) => (
              <option key={option} value={option}>
                {t(`frequencies.${option}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="startDate">{frequency === 'once' ? t('dueDate') : t('firstDate')}</label>
          <input id="startDate" name="startDate" type="date" defaultValue={rule?.startDate ?? todayLocal()} required />
        </div>
      </div>
      {NEEDS_INTERVAL.has(frequency) && (
        <div className="field">
          <label htmlFor="interval">{frequency === 'every_n_weeks' ? t('everyWeeks') : t('everyMonths')}</label>
          <input id="interval" name="interval" type="number" min={1} max={60} defaultValue={rule?.interval ?? 2} />
        </div>
      )}
      {frequency !== 'once' && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="endDate">{t('endDate')}</label>
            <input id="endDate" name="endDate" type="date" defaultValue={rule?.endDate ?? ''} />
          </div>
          <div className="field">
            <label htmlFor="nonWorkingDay">{t('weekend')}</label>
            <select id="nonWorkingDay" name="nonWorkingDay" defaultValue={rule?.nonWorkingDay ?? 'on_date'}>
              <option value="on_date">{t('weekendOnDate')}</option>
              <option value="previous">{t('weekendPrevious')}</option>
              <option value="next">{t('weekendNext')}</option>
            </select>
          </div>
        </div>
      )}
      <label className="check">
        <input type="checkbox" name="estimated" defaultChecked={rule?.amountType === 'estimated'} /> <span>{t('estimated')}</span>
      </label>
      {kind === 'income' && (
        <>
          <label className="check">
            <input type="checkbox" checked={isPayday} onChange={(event) => setIsPayday(event.target.checked)} /> <span>{t('payday')}</span>
          </label>
          <p className="small muted">{t('paydayHint')}</p>
          {isPayday && (
            <>
              <div className="field">
                <label htmlFor="payer">{t('payer')}</label>
                <input id="payer" name="payer" type="text" maxLength={100} defaultValue={rule?.payer ?? ''} required />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="min">{t('expectedMin')}</label>
                  <input id="min" name="min" type="text" inputMode="decimal" defaultValue={rule?.expectedMin_minor != null ? editableAmount(rule.expectedMin_minor) : ''} />
                </div>
                <div className="field">
                  <label htmlFor="max">{t('expectedMax')}</label>
                  <input id="max" name="max" type="text" inputMode="decimal" defaultValue={rule?.expectedMax_minor != null ? editableAmount(rule.expectedMax_minor) : ''} />
                </div>
              </div>
            </>
          )}
        </>
      )}
      {kind !== 'income' && goals.length > 0 && (
        <div className="field">
          <label htmlFor="goalId">{t('saveForBill')}</label>
          <select id="goalId" name="goalId" defaultValue={rule?.goalId ?? ''}>
            <option value="">{t('noGoal')}</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {rule && (
        <div className="field">
          <label htmlFor="effectiveFrom">{t('effectiveFrom')}</label>
          <input id="effectiveFrom" name="effectiveFrom" type="date" defaultValue={todayLocal()} aria-describedby="effective-hint" />
          <span id="effective-hint" className="hint">
            {t('effectiveHint')}
          </span>
        </div>
      )}
      {problem && (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      )}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {t('save')}
      </button>
    </form>
  );
}
