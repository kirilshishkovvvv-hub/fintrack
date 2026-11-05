'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { RuleForm } from '@/components/RuleForm';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { loadGoals, loadRules } from '@/lib/plan';
import { active, loadAccounts, loadCategories, notifyDataChanged, useApiData } from '@/lib/use-api';

/** BR-08.6: an edit applies from a date onward. Past and individually edited items keep their values. */
export default function RulePage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('rules');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const { data, failed, reload } = useApiData(async () => {
    const [rules, accounts, categories, goals] = await Promise.all([loadRules(), loadAccounts(), loadCategories(), loadGoals()]);
    return { rule: rules.find((rule) => rule.id === id) ?? null, accounts: active(accounts), categories: active(categories), goals: goals.filter((goal) => goal.status === 'active') };
  });
  if (failed) return <LoadError retry={reload} />;

  async function run(work: () => Promise<unknown>, done: () => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      done();
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const rule = data?.rule;
  return (
    <AppShell>
      <p className="small">
        <Link href="/plan/rules">{t('backToRules')}</Link>
      </p>
      <h1>{rule ? t('editTitle', { name: rule.name }) : t('title')}</h1>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-info" role="status">
          {notice}
        </p>
      )}
      {!data ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : !rule ? (
        <p className="notice notice-error" role="alert">
          {t('notFound')}
        </p>
      ) : rule.status === 'ended' ? (
        <p className="muted">{t('endedNote')}</p>
      ) : (
        <>
          <RuleForm
            key={rule.version}
            accounts={data.accounts}
            categories={data.categories}
            goals={data.goals}
            rule={rule}
            busy={busy}
            onSave={(body) => void run(() => api('PATCH', `/api/v1/rules/${id}`, { ifMatch: rule.version, body }), () => setNotice(t('saved')))}
          />
          <section className="card">
            {ending ? (
              <>
                <p>{t('endConfirm')}</p>
                <div className="actions">
                  <button className="btn" type="button" disabled={busy} onClick={() => void run(() => api('POST', `/api/v1/rules/${id}/end`, { idempotencyKey: newIdempotencyKey(), body: {} }), () => router.replace('/plan/rules'))}>
                    {t('endYes')}
                  </button>
                  <button className="btn" type="button" onClick={() => setEnding(false)}>
                    {tApp('cancel')}
                  </button>
                </div>
              </>
            ) : (
              <button className="btn" type="button" onClick={() => setEnding(true)}>
                {t('end')}
              </button>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
