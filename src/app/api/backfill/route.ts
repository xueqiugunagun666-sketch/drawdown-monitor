import { NextResponse } from 'next/server';
import { requireActor, isDenied } from '../../../lib/accountAuthServer.ts';
import { backfillProgress } from '../../../worker/backfill.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const actor = requireActor(req);
  if (isDenied(actor)) return actor;
  return NextResponse.json({
    progress: backfillProgress(),
    jobs: repo.listBackfillJobs(),
  });
}
