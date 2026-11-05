'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { ConfirmIdentity } from '@/components/ConfirmIdentity';
import { api, ApiProblem, newIdempotencyKey } from '@/lib/api';
import { dateLocale } from '@/lib/money';
import { useApiData } from '@/lib/use-api';

interface WorkspaceStatus {
  status: 'active' | 'deletion_pending' | 'purged';
  purgeAfter: string | null;
}

/**
 * Account deletion (Stage 2 §8.6, GAP-5, Annex L item 20). Export is offered first, the password
 * is confirmed if the sign-in isn't recent, and there are 7 days to change one's mind.
 */
export default function DeleteAccountPage() {
  const t = useTranslations('deleteAccount');
  const tApp = useTranslations('app');
  const locale = useLocale();
  const [understood, setUnderstood] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [requested, setRequested] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const pendingAction = useRef<() => Promise<void>>(async () => undefined);
  const { data, failed, reload } = useApiData(() => api<WorkspaceStatus>('GET', '/api/v1/workspace'));
  if (failed) return <LoadError retry={reload} />;

  const day = (iso: string) => new Intl.DateTimeFormat(dateLocale(locale), { dateStyle: 'long' }).format(new Date(iso));

  async function act(path: string, done: (result: WorkspaceStatus) => void) {
    setBusy(true);
    setError(null);
    pendingAction.current = () => act(path, done);
    try {
      const result = await api<WorkspaceStatus>('POST', path, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setNeedsPassword(false);
      done(result);
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.code === 'REAUTH_REQUIRED') setNeedsPassword(true);
      else setError(tApp('genericError'));
    } finally {
      setBusy(false);
    }
  }

  const requestDeletion = () => act('/api/v1/workspace/deletion', (result) => setRequested(result.purgeAfter));
  const cancelDeletion = () =>
    act('/api/v1/workspace/deletion/cancel', () => {
      setKept(true);
      void reload();
    });

  // The sessions have just ended, so this screen has no signed-in navigation to offer.
  if (requested) {
    return (
      <main id="main" className="auth-wrap">
        <div className="card">
          <h1>{t('scheduled')}</h1>
          <p>{t('requestedBody', { date: day(requested) })}</p>
          <Link href="/sign-in" className="btn btn-primary">
            {t('signIn')}
          </Link>
        </div>
      </main>
    );
  }

  const errorNotice = error && (
    <p className="notice notice-error" role="alert">
      {error}
    </p>
  );

  return (
    <AppShell>
      {!data ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : kept ? (
        <section className="card">
          <p role="status">{t('kept')}</p>
          <Link href="/dashboard" className="btn btn-primary">
            {t('home')}
          </Link>
        </section>
      ) : data.status === 'deletion_pending' ? (
        <>
          <h1>{t('scheduled')}</h1>
          <section className="card">
            <p>{t('scheduledBody', { date: day(data.purgeAfter!) })}</p>
            <div className="actions">
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void cancelDeletion()}>
                {t('cancel')}
              </button>
              <Link href="/export" className="btn">
                {t('exportLink')}
              </Link>
            </div>
          </section>
          {errorNotice}
        </>
      ) : (
        <>
          <h1>{t('title')}</h1>
          <section className="card">
            <p>{t('intro')}</p>
            <p>{t('steps')}</p>
            <p className="notice notice-info small">
              {t('exportFirst')} <Link href="/export">{t('exportLink')}</Link>
            </p>
            {!needsPassword && (
              <>
                <label className="check" style={{ marginBottom: '0.75rem' }}>
                  <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
                  <span>{t('understand')}</span>
                </label>
                <button className="btn btn-danger" type="button" disabled={busy || !understood} onClick={() => void requestDeletion()}>
                  {t('submit')}
                </button>
              </>
            )}
          </section>
          {errorNotice}
        </>
      )}
      {needsPassword && <ConfirmIdentity onConfirmed={() => pendingAction.current()} />}
    </AppShell>
  );
}
