import { serverApp } from '@/server/app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every /api request goes to the one application handler (Stage 2 §4). */
async function handler(request: Request): Promise<Response> {
  return serverApp().handle(request);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
