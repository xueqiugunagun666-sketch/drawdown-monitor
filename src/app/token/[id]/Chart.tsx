'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi } from 'lightweight-charts';

const CHART_HEIGHT = 420;

export interface PriceLine { price: number; color: string; title: string }

interface Props {
  tokenId: string;
  timeframe: string;
  quoteMode: string;
  /** 窗口起点（秒），按模式裁剪 */
  from: number;
  priceLines: PriceLine[];
  /** 历史报警时刻，用于在图上打标记 */
  markers: Array<{ time: number; text: string }>;
}

interface Bar { time: number; open: number; high: number; low: number; close: number }

export default function Chart({ tokenId, timeframe, quoteMode, from, priceLines, markers }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('加载中…');

  useEffect(() => {
    const el = box.current;
    if (!el) return;

    // 图表必须在 effect 里**同步**创建，不能等 fetch 回来再建：
    // React StrictMode 会挂载两次，异步创建会让实例生命周期与 effect 脱节，
    // 容器里留下两个图表 —— 屏幕上显示的是一个，而代码握着的是另一个（已分离），
    // 对它调 fitContent / setVisibleLogicalRange 全是空操作。
    el.replaceChildren();

    const chart: IChartApi = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#a3a3a3' },
      grid: { vertLines: { color: '#1c1c1c' }, horzLines: { color: '#1c1c1c' } },
      rightPriceScale: { borderColor: '#262626' },
      // minBarSpacing 默认 0.5px/根，上千根 candle 时 fitContent 会被下限挡住
      timeScale: { borderColor: '#262626', timeVisible: true, minBarSpacing: 0.005 },
      width: Math.max(el.clientWidth, 1),
      height: CHART_HEIGHT,
    });

    const series: ISeriesApi<'Candlestick'> = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      priceFormat: { type: 'price', precision: 12, minMove: 1e-12 },
    });

    // 挂载瞬间容器宽度可能还是 0（画布 style width 会停在 0px，
    // 时间轴此时算不出任何可视区间，fitContent 静默失效）。
    // 因此不能在 setData 之后无条件 fitContent —— 必须等宽度真的就绪。
    let hasData = false;
    let fitted = false;
    let width = el.clientWidth;
    const fitIfReady = () => {
      // 数据与宽度两个条件都满足才 fit，谁后到都触发一次
      if (fitted || !hasData || width <= 0) return;
      chart.timeScale().fitContent();
      fitted = true;
    };

    // 用 ResizeObserver 而非 requestAnimationFrame —— rAF 在非可见标签页里不触发
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (!w || w <= 0) return;
      width = w;
      chart.applyOptions({ width: Math.floor(w) });
      fitIfReady();
    });
    ro.observe(el);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/tokens/${encodeURIComponent(tokenId)}/candles?timeframe=${timeframe}&quoteMode=${quoteMode}&from=${from}`,
        );
        if (!res.ok) { if (!cancelled) setStatus(`加载失败: HTTP ${res.status}`); return; }
        const data = await res.json() as { candles: Bar[] };
        if (cancelled) return;
        if (data.candles.length === 0) { setStatus('该粒度下暂无数据'); return; }

        series.setData(data.candles as never);
        for (const l of priceLines) {
          series.createPriceLine({
            price: l.price, color: l.color, lineWidth: 1,
            lineStyle: 2, axisLabelVisible: true, title: l.title,
          });
        }
        if (markers.length > 0) {
          series.setMarkers(markers.map((m) => ({
            time: m.time as never, position: 'aboveBar' as const,
            color: '#f59e0b', shape: 'arrowDown' as const, text: m.text,
          })));
        }
        hasData = true;
        fitIfReady();
        setStatus('');
      } catch (err) {
        if (!cancelled) setStatus(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    return () => { cancelled = true; ro.disconnect(); chart.remove(); };
    // priceLines / markers 每次服务端渲染都是新数组引用，放进依赖会导致重复建图。
    // 它们的内容由 tokenId/timeframe/quoteMode 决定，跟随这三者即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenId, timeframe, quoteMode, from]);

  return (
    <div className="relative">
      <div ref={box} className="w-full" style={{ height: CHART_HEIGHT }} />
      {status && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500 pointer-events-none">
          {status}
        </div>
      )}
    </div>
  );
}
