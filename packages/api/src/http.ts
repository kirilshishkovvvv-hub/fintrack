/**
 * HTTP helpers. Errors use RFC 9457 problem details with stable codes (Stage 2 §9.1);
 * the UI translates the code, so messages here are for developers, not end users.
 */
export type ProblemCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'VALIDATION_FAILED'
  | 'LEDGER_RULE'
  | 'INVALID_REFERENCE'
  | 'CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'NO_WORKSPACE'
  | 'VERSION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'INVALID_STATE'
  | 'NOT_EDITABLE'
  | 'UNDO_EXPIRED'
  | 'LOCKED_RECONCILED'
  | 'RECONCILIATION_DIFFERENCE'
  | 'ARCHIVE_BLOCKED'
  | 'INTERNAL';

export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ProblemCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

export function problem(error: ApiError): Response {
  return new Response(
    JSON.stringify({
      type: `https://fintrack.app/problems/${error.code.toLowerCase().replaceAll('_', '-')}`,
      title: error.message,
      status: error.status,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    }),
    { status: error.status, headers: { 'content-type': 'application/problem+json; charset=utf-8', ...SECURITY_HEADERS } },
  );
}

/** Like readJson, but a request without a body reads as {} (for actions such as void). */
export async function readOptionalJson(request: Request): Promise<unknown> {
  if (!request.body || request.headers.get('content-length') === '0') return {};
  return readJson(request);
}

/** The version named in `If-Match`, as a plain number or a quoted ETag (Stage 2 §9.1, "Ver"). */
export function requiredVersion(request: Request): number {
  const value = request.headers.get('if-match')?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  const version = Number(value);
  if (!value || !Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(428, 'VERSION_REQUIRED', 'Send the version you are changing in an If-Match header');
  }
  return version;
}

export async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new ApiError(415 as number, 'VALIDATION_FAILED', 'Send the request body as application/json');
  }
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The request body is not valid JSON');
  }
}

/** A stable SHA-256 of the method, path and canonical JSON body, for idempotency. */
export async function requestHash(method: string, path: string, body: unknown): Promise<string> {
  const canonical = JSON.stringify(sortKeys(body));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${method} ${path}\n${canonical}`));
  return Buffer.from(digest).toString('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}
