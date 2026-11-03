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
}

export async function api<T>(method: 'GET' | 'POST', path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
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

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}
