'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { api, ApiProblem, newIdempotencyKey } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import { todayLocal } from '@/lib/use-api';

const TYPES = ['current', 'savings', 'cash', 'card', 'loan', 'investment', 'lent', 'other_asset', 'other_liability'] as const;
const LIABILITIES = new Set(['card', 'loan', 'other_liability']);

export default function NewAccountPage() {
  const t = useTranslations('newAccount');
  const tTypes = useTranslations('accountTypes');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [type, setType] = useState<(typeof TYPES)[number]>('current');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = String(form.get('opening') ?? '').trim();
    const opening = raw === '' ? 0 : parseUserAmount(raw);
    if (opening === null) return setError(tErrors('invalidAmount'));
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/v1/accounts', {
        idempotencyKey: key.current,
        body: { name: String(form.get('name') ?? '').trim(), type, openingDate: String(form.get('openingDate')), openingAmount_minor: opening },
      });
      router.replace('/dashboard');
    } catch (problem) {
      const code = problem instanceof ApiProblem ? problem.code : '';
      setError(code === 'LEDGER_RULE' ? tErrors('futureDate') : tErrors(code === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED' : 'LEDGER_RULE'));
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="name">{t('name')}</label>
          <input id="name" name="name" type="text" required maxLength={100} />
        </div>
        <div className="field">
          <label htmlFor="type">{t('type')}</label>
          <select id="type" value={type} onChange={(event) => setType(event.target.value as (typeof TYPES)[number])}>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {tTypes(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="openingDate">{t('openingDate')}</label>
          <input id="openingDate" name="openingDate" type="date" defaultValue={todayLocal()} max={todayLocal()} required />
        </div>
        <div className="field">
          <label htmlFor="opening">{LIABILITIES.has(type) ? t('openingOwed') : t('openingBalance')}</label>
          <input id="opening" name="opening" type="text" inputMode="decimal" placeholder="0.00" className="amount-input" />
        </div>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {t('submit')}
        </button>
      </form>
    </AppShell>
  );
}
