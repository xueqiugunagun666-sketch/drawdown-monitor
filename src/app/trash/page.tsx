import Nav from '../../components/Nav.tsx';
import { listSignals } from '../../db/trashRepo.ts';
import { isConfigured } from '../../sources/trashSignals.ts';
import TrashList, { type SignalRow } from './TrashList.tsx';

export const dynamic = 'force-dynamic';

export default function TrashPage() {
  const rows = listSignals(200) as unknown as SignalRow[];
  return (
    <main className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <Nav current="/trash" />
      <h1 className="text-[26px] font-semibold tracking-tight leading-none">群聊淘金</h1>
      <p className="text-xs text-neutral-500 mt-1.5 mb-5">
        各个群喊过的币，从峰值跌下来之后捡回来看一眼
      </p>
      {/* 没配置就直说。静默空白最难查 —— 分不清是"没信号"还是"没接上" */}
      {!isConfigured() && (
        <p className="mb-4 rounded border border-[#fab219]/40 bg-[#fab219]/10 px-3 py-2 text-sm text-[#fab219]">
          还没配置信号源（TRASH_API_BASE / TRASH_API_TOKEN），这一栏不会有数据。
        </p>
      )}
      <TrashList initial={rows} />
    </main>
  );
}
