/**
 * 90 天迷你走势 —— 规格 §9.1 的「迷你走势」。
 *
 * 小倍数：每行一条，同一测度重复，因此统一用一个颜色，
 * 不按行着色（颜色应跟随实体而非排名）。
 * 只画趋势不画坐标轴 —— 精确数值在详情页看，这里只回答「形状对不对」。
 */
interface Props {
  points: number[];
  width?: number;
  height?: number;
  /** 高点位置，画一个标记 */
  athIndex?: number | null;
}

export default function Sparkline({ points, width = 116, height = 36, athIndex = null }: Props) {
  if (points.length < 2) {
    return <div style={{ width, height }} className="flex items-center text-xs text-neutral-700">—</div>;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  // 上下各留 2px，避免线贴边被裁
  const pad = 2;
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaD = `${d} L${width},${height} L0,${height} Z`;
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1]!);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={`90 天走势，共 ${points.length} 个采样点`}
      className="overflow-visible">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3987e5" stopOpacity="0.32" />
          <stop offset="55%" stopColor="#3987e5" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#3987e5" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* 高点参考线：没有它，一条曲线只能看出"起伏"，
          看不出"现在离最高点还有多远"——而后者才是这个工具的问题 */}
      {athIndex !== null && athIndex >= 0 && athIndex < points.length && (
        <line x1="0" x2={width} y1={y(points[athIndex]!)} y2={y(points[athIndex]!)}
          stroke="#fab219" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="2 3" />
      )}
      <path d={areaD} fill="url(#spark-fill)" />
      {/* 2px 线宽，符合细笔画规范 */}
      <path d={d} fill="none" stroke="#3987e5" strokeWidth="1.75"
        strokeLinejoin="round" strokeLinecap="round" />
      {athIndex !== null && athIndex >= 0 && athIndex < points.length && (
        <circle cx={x(athIndex)} cy={y(points[athIndex]!)} r="2.25"
          fill="#141414" stroke="#fab219" strokeWidth="1.5" />
      )}
      {/* 当前点：2px 表面色描边，避免与线重叠糊在一起 */}
      <circle cx={lastX} cy={lastY} r="2.75" fill="#3987e5" stroke="#141414" strokeWidth="2" />
    </svg>
  );
}
