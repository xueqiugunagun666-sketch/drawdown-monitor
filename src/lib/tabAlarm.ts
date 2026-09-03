/**
 * 标签页级别的告警：改标题、换 favicon。
 *
 * 这是提示音失效时**唯一不依赖任何权限**的通道。系统通知要用户授权过才
 * 弹得出来，而标签页的标题和图标是白给的 —— 人扫一眼标签栏就看得见，
 * 哪怕正在别的标签里干活。
 *
 * 用它而不是只靠页面内的横幅，是因为横幅和静音一样看不见：
 * 人正是因为没听见声音才没在看这个页面。
 */

const BASE_TITLE = 'Show Tools';
const ICON_ID = 'health-alarm-icon';

/**
 * 红点图标。用 data URI 内联的 SVG，不引入文件 ——
 * 少一个"文件加载失败但页面没报错"的静默故障。
 */
const ALARM_ICON =
  'data:image/svg+xml,'
  + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<circle cx="16" cy="16" r="14" fill="#d03b3b"/>'
    + '<rect x="14" y="7" width="4" height="12" rx="2" fill="#fff"/>'
    + '<circle cx="16" cy="24" r="2.4" fill="#fff"/>'
    + '</svg>',
  );

/**
 * 占用期。测试告警在这段时间里独占标签页，看门狗的常规刷新不许覆盖。
 *
 * 加这个是因为测试按钮当场暴露的问题：看门狗每秒 tick 一次、无条件把标题
 * 写成当前健康状态，于是测试刚设上的告警不到一秒就被刷掉了 ——
 * 按钮报告"标签页告警 ✓"，标签栏上其实什么都没发生。
 * 两处在无协调地写同一个东西，必须有个仲裁。
 */
let holdUntil = 0;

/**
 * 打开/关闭告警。message 为 null 表示恢复正常。
 *
 * 标题前缀用「⚠️」而不是纯文字：标签页很窄，多数时候只看得见头几个字符。
 */
export function setTabAlarm(message: string | null): void {
  if (typeof document === 'undefined') return;
  if (Date.now() < holdUntil) return;              // 测试占用中，让位

  document.title = message ? `⚠️ ${message} — ${BASE_TITLE}` : BASE_TITLE;

  const existing = document.getElementById(ICON_ID);
  if (!message) {
    existing?.remove();
    return;
  }
  if (existing) return;                       // 已经在告警，不重复插

  const link = document.createElement('link');
  link.id = ICON_ID;
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = ALARM_ICON;
  document.head.appendChild(link);
}

/**
 * 测试用：设一条告警并独占标签页 ms 毫秒。
 *
 * 占用期一过，看门狗下一次 tick（1 秒内）会按真实健康状态把它刷掉，
 * 不需要谁去清理 —— 少一处"忘了清"的可能。
 */
export function holdTabAlarm(message: string, ms: number): void {
  holdUntil = 0;                                   // 先解除，好让这次写得进去
  setTabAlarm(message);
  holdUntil = Date.now() + ms;
}

/** 立刻结束占用并恢复正常标题。组件卸载时用 */
export function releaseTabAlarm(): void {
  holdUntil = 0;
  setTabAlarm(null);
}

/** 标签页此刻是否真的处于告警状态。测试要读回真实状态，不能写死打勾 */
export function tabAlarmActive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.title.startsWith('⚠️') && document.getElementById(ICON_ID) !== null;
}
