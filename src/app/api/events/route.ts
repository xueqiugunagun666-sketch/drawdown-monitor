import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { checkAuth } from '../../../lib/auth.ts';
import { readName } from '../../../lib/user.ts';
import { parseEventInput } from '../../../lib/eventInput.ts';
import { nowSec } from '../../../lib/time.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  const includePast = new URL(req.url).searchParams.get('past') === '1';
  return NextResponse.json({ events: repo.listEvents({ includePast }) });
}

export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  const parsed = parseEventInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const v = parsed.value;

  const id = randomUUID();
  repo.upsertEvent({
    id, title: v.title, atTs: v.atTs, inputTz: v.inputTz,
    category: v.category, priority: v.priority, note: v.note,
    links: JSON.stringify(v.links),
    remindOffsets: JSON.stringify(v.remindOffsets),
    remindedOffsets: null,
    createdBy: readName(req),
    createdAt: nowSec(), enabled: 1,
  });
  return NextResponse.json({ event: repo.getEvent(id) }, { status: 201 });
}
