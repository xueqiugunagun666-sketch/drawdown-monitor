import { NextResponse } from 'next/server';
import { requireActor, isDenied } from '../../../lib/accountAuthServer.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const actor = requireActor(req);
  if (isDenied(actor)) return actor;
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 200), 500);
  return NextResponse.json({ alerts: repo.listAlerts(limit) });
}
