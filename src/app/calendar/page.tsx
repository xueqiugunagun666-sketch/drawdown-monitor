import Nav from '../../components/Nav.tsx';
import CalendarClient, { type EventItem } from './CalendarClient.tsx';
import * as repo from '../../db/repo.ts';

export const dynamic = 'force-dynamic';

export default async function CalendarPage({
  searchParams,
}: { searchParams: Promise<{ past?: string }> }) {
  const sp = await searchParams;
  const showPast = sp.past === '1';
  const events = repo.listEvents({ includePast: showPast }) as unknown as EventItem[];

  return (
    <main className="p-4 md:p-8 max-w-[1000px] mx-auto">
      <Nav current="/calendar" />
      <h1 className="text-xl font-semibold mb-1">项目日历</h1>
      <p className="text-xs text-neutral-500 mb-5">
        录入时可选时区，列表与推送统一按北京时间显示。到点推 Telegram。
      </p>
      <CalendarClient events={events} showPast={showPast} />
    </main>
  );
}
