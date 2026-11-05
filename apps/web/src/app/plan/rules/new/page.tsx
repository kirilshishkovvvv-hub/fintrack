'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { RuleForm } from '@/components/RuleForm';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { loadGoals, loadOccurrences, type Rule } from '@/lib/plan';
import { active, loadAccounts, loadCategories, notifyDataChanged, useApiData } from '@/lib/use-api';

function NewRule() {
  const t = useTranslations('rules');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const params = useSearchParams();
  const key = useRef(newIdempotencyKey());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<Rule | null>(null);
  const { data, failed, reload } = useApiData(async () => {
    const [accounts, categories, goals] = await Promise.all([loadAccounts(), loadCategories(), loadGoals()]);
    return { accounts: active(accounts), categories: active(categories), goals: goals.filter((goal) => goal.status === 'active') };
  });
  if (failed) return <LoadError retry={reload} />;

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const created = await api<Rule>('POST', '/api/v1/rules', { idempotencyKey: key.current, body });
      notifyDataChanged();
      // A start date in the past makes overdue items: ask, rather than quietly counting them.
      if (created.overdue > 0) {
        setPast(created);
        setBusy(false);
        return;
      }
      router.replace('/plan');
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      setBusy(false);
    }
  }

  async function skipPast() {
    if (!past) return;
    setBusy(true);
    setError(null);
    try {
      const overdue = (await loadOccurrences()).filter((item) => item.ruleId === past.id && item.overdue);
      for (const item of overdue) await api('POST', `/api/v1/occurrences/${item.id}/skip`, { idempotencyKey: newIdempotencyKey() });
      notifyDataChanged();
      router.replace('/plan');
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      setBusy(false);
    }
  }

  if (past) {
    return (
      <AppShell>
        <h1>{t('newTitle')}</h1>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <section className="card">
          <p>{t('pastDates', { count: past.overdue })}</p>
          <div className="actions">
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void skipPast()}>
              {t('pastSkip')}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => router.replace('/plan')}>
              {t('pastReview')}
            </button>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1>{t('newTitle')}</h1>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {!data ? <p aria-live="polite">{tApp('loading')}</p> : <RuleForm accounts={data.accounts} categories={data.categories} goals={data.goals} payday={params.get('payday') === '1'} busy={busy} onSave={(body) => void save(body)} />}
    </AppShell>
  );
}

export default function NewRulePage() {
  return (
    <Suspense>
      <NewRule />
    </Suspense>
  );
}
