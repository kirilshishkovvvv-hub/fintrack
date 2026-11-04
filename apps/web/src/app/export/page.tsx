'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { ConfirmIdentity } from '@/components/ConfirmIdentity';

/** Self-service export (FR-17, PRV-03). The server asks for a recent sign-in first (BR-01.5). */
export default function ExportPage() {
  const t = useTranslations('export');
  const tApp = useTranslations('app');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/exports', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { code?: string } | null;
        if (problem?.code === 'REAUTH_REQUIRED') {
          setNeedsPassword(true);
          setMessage(null);
        } else {
          setMessage({ kind: 'error', text: tApp('genericError') });
        }
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
    } catch {
      setMessage({ kind: 'error', text: tApp('genericError') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <section className="card">
        <p>{t('intro')}</p>
        <p className="small muted">{t('warning')}</p>
        {!needsPassword && (
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void download()}>
            {t('download')}
          </button>
        )}
      </section>
      {needsPassword && <ConfirmIdentity onConfirmed={download} />}
      {message && (
        <p className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </AppShell>
  );
}
