import { NextResponse } from 'next/server';
import { checkAuth } from '../../../lib/auth.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 200), 500);
  return NextResponse.json({ alerts: repo.listAlerts(limit) });
}
