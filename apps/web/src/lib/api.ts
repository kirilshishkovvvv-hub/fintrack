/**
 * Browser-side API client. The browser only sends intentions and displays what the server
 * returns; it never computes an authoritative figure (Stage 2 §4.1).
 */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface Options {
  body?: unknown;
  /** The same key must be reused when the same submission is retried (Stage 2 §7.5). */
  idempotencyKey?: string;
  /** The version being changed; a stale one is refused with VERSION_CONFLICT. */
  ifMatch?: number;
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(path, init);
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ApiProblem(response.status, data?.code ?? 'INTERNAL', data?.message ?? data?.title ?? 'Request failed', data?.details);
  }
  return data as T;
}

const TRANSLATED_CODES = new Set([
  'INVALID_REFERENCE',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'INVALID_STATE',
  'NOT_EDITABLE',
  'LOCKED_RECONCILED',
  'RECONCILIATION_DIFFERENCE',
  'ARCHIVE_BLOCKED',
  'IMPORT_TOO_LARGE',
  'DECISIONS_REQUIRED',
  'CURRENCY_CONFIRM_REQUIRED',
]);

/** The user-facing message for a failed change, from the problem's stable code (Stage 2 §9.1). */
export function errorMessage(problem: unknown, tErrors: (key: string) => string): string {
  if (!(problem instanceof ApiProblem)) return tErrors('LEDGER_RULE');
  if (JSON.stringify(problem.details ?? '').includes('future')) return tErrors('futureDate');
  return tErrors(TRANSLATED_CODES.has(problem.code) ? problem.code : 'LEDGER_RULE');
}

/** Sends a file with a form, reporting problems the same way as api(). */
export async function postForm<T>(path: string, form: FormData, idempotencyKey?: string): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin', headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} });
  const data = (await response.json().catch(() => null)) as (T & { code?: string; title?: string; details?: unknown }) | null;
  if (!response.ok) throw new ApiProblem(response.status, data?.code ?? 'INTERNAL', data?.title ?? 'Request failed', data?.details);
  return data as T;
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}
