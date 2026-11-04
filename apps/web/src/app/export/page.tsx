'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { api, ApiProblem } from '@/lib/api';

/** Self-service export (FR-17, PRV-03). The server asks for a recent sign-in first (BR-01.5). */
export default function ExportPage() {
  const t = useTranslations('export');
  const tApp = useTranslations('app');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    const response = await fetch('/api/v1/exports', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { code?: string } | null;
      if (problem?.code === 'REAUTH_REQUIRED') {
        setNeedsPassword(true);
        setMessage(null);
        return;
      }
      setMessage({ kind: 'error', text: tApp('genericError') });
      return;
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'fintrack-export.zip';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    setNeedsPassword(false);
    setMessage({ kind: 'info', text: t('done') });
  }

  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch {
      setMessage({ kind: 'error', text: tApp('genericError') });
    } finally {
      setBusy(false);
    }
  }

  function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void guarded(async () => {
      try {
        await api('POST', '/api/auth/sign-in/email', { body: { email: String(form.get('email') ?? '').trim(), password: String(form.get('password') ?? '') } });
      } catch (problem) {
        if (problem instanceof ApiProblem && (problem.status === 401 || problem.status === 403)) return setMessage({ kind: 'error', text: t('invalid') });
        throw problem;
      }
      await download();
    });
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <section className="card">
        <p>{t('intro')}</p>
        <p className="small muted">{t('warning')}</p>
        {!needsPassword && (
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void guarded(download)}>
            {t('download')}
          </button>
        )}
      </section>
      {needsPassword && (
        <form className="card" onSubmit={confirm}>
          <p>{t('reauth')}</p>
          <div className="field">
            <label htmlFor="email">{t('email')}</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="password">{t('password')}</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('confirm')}
          </button>
        </form>
      )}
      {message && (
        <p className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </AppShell>
  );
}
