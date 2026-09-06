/**
 * 暴涨提示：中文语音播报 +（提示前的）轻提示音 + 系统通知。
 *
 * 用浏览器内置的 SpeechSynthesis 而不是音频文件：不加依赖、不占打包体积，
 * 也省掉"文件加载失败但页面没报错"这一类静默故障。
 *
 * 两个绕不过去的浏览器限制：
 *
 * 1. **禁止未经交互的自动播放。** AudioContext 与 SpeechSynthesis 都要
 *    在一次真实点击的事件处理里激活。所以要有显式的"开启声音"开关，
 *    而且换设备、清缓存后要重新点。
 *
 * 2. **状态必须显眼。** 用户以为开着、其实没声音，是这个功能最危险的
 *    失效方式 —— 比误报危险得多，因为它是静默的（第 4 条铁律）。
 *    没有中文语音时也要说出来，而不是安静地退回滴一声。
 */
export type SoundStatus = 'locked' | 'ready' | 'blocked';

/**
 * 播报内容。两种报警念**不同的话** —— 都念「有东西暴涨了」的话，
 * 光靠听分不出是哪一种，而这两件事该做的反应不一样：
 * 暴涨是"从低点弹起来了"，破新高是"进入价格发现区、头上没有套牢盘"。
 */
export const PUMP_PHRASE = '有东西暴涨了';
export const ATH_PHRASE = '有币创新高了';
/** 系统消息（数据源故障之类）。念得不一样，好让人知道这不是行情 */
export const SYSTEM_PHRASE = '监控系统有情况';
/** 同批同时有暴涨与新高时，声音只响一次但不能只说其中一种。 */
export const MIXED_ALERT_PHRASE = '有币暴涨或创新高了';
/** 同批同时有系统故障与行情时，系统通知和行情通知仍分开投递。 */
export const SYSTEM_AND_MARKET_PHRASE = '监控系统有情况，行情也有异动';

let ctx: AudioContext | null = null;

export function soundStatus(): SoundStatus {
  if (!ctx) return 'locked';
  return ctx.state === 'running' ? 'ready' : 'blocked';
}

/**
 * 状态变化时回调。返回取消订阅的函数。
 *
 * 存在的理由是一次真实事故：开关只在页面加载时查一次状态，而浏览器会在
 * 后台标签页、系统休眠之后**挂起 AudioContext**。一旦挂起，chime() 里
 * `ctx.state !== 'running'` 直接 return，什么都不响，页面上却仍然写着
 * 「● 声音已开启」。用户网页开了一下午，以为在盯着，其实早就哑了 ——
 * 正是第 4 条铁律说的那种静默失效。
 *
 * 两个来源都要听：AudioContext 自己的 statechange，以及标签页重新可见时
 * 主动复查（某些浏览器挂起时不发 statechange）。
 */
const watchers = new Set<(s: SoundStatus) => void>();

/** 通知所有订阅者。ctx 换了、状态变了、页面回到前台，都走这里 */
function notifyWatchers(): void {
  const s = soundStatus();
  for (const w of watchers) w(s);
}

export function watchSoundStatus(cb: (s: SoundStatus) => void): () => void {
  watchers.add(cb);
  cb(soundStatus());                     // 订阅时先给一次当前值，别让调用方等第一次变化
  const onVisible = () => { if (document.visibilityState === 'visible') notifyWatchers(); };
  document.addEventListener('visibilitychange', onVisible);
  // 挂起有时既不发 statechange 也不伴随可见性切换，兜一个低频轮询
  const timer = setInterval(notifyWatchers, 15_000);
  return () => {
    watchers.delete(cb);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}

/* ---------------- 语音 ---------------- */

/**
 * 中文女声优先级。不同系统的语音库差很远，按名字挨个试，
 * 都没有就退到任意 zh-CN，再退到任意 zh-*。
 */
const PREFERRED = [
  '婷婷', 'Tingting', '语舒',                                   // macOS / iOS
  'Microsoft Xiaoxiao', 'Microsoft Huihui', 'Microsoft Yaoyao',  // Windows
  'Google 普通话（中国大陆）', 'Google Mandarin',                 // Chrome / Android
  'Sandy', 'Shelley', 'Flo',                                     // macOS 新版女声
];

export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const zh = voices.filter((v) => /^zh/i.test(v.lang));
  if (zh.length === 0) return null;
  for (const want of PREFERRED) {
    const hit = zh.find((v) => v.name.includes(want));
    if (hit) return hit;
  }
  return zh.find((v) => /^zh[-_]?CN/i.test(v.lang)) ?? zh[0] ?? null;
}

let cachedVoice: SpeechSynthesisVoice | null = null;
let voiceResolved = false;

/** voices 是异步加载的，首次 getVoices() 常常返回空数组 */
export async function loadVoice(): Promise<SpeechSynthesisVoice | null> {
  if (voiceResolved) return cachedVoice;
  if (typeof speechSynthesis === 'undefined') { voiceResolved = true; return null; }

  const list = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
    const now = speechSynthesis.getVoices();
    if (now.length > 0) return resolve(now);
    const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 2000);
    speechSynthesis.addEventListener('voiceschanged', () => {
      clearTimeout(t);
      resolve(speechSynthesis.getVoices());
    }, { once: true });
  });

  cachedVoice = pickVoice(list);
  voiceResolved = true;
  return cachedVoice;
}

/** 当前用的是哪个语音；null 表示这台设备没有中文语音 */
export function currentVoiceName(): string | null {
  return cachedVoice?.name ?? null;
}

export function speakPump(phrase: string = PUMP_PHRASE): boolean {
  if (typeof speechSynthesis === 'undefined' || !cachedVoice) return false;
  try {
    // 上一条还没播完会排队，暴涨提示要的是"立刻知道"，直接顶掉
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(phrase);
    u.voice = cachedVoice;
    u.lang = cachedVoice.lang;
    u.volume = 1;
    u.rate = 0.95;      // 略慢一点，短句才听得清
    u.pitch = 1;
    speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 提示音 ---------------- */

/**
 * 播报前的引起注意音。上行两音，柔和 ——
 * 之前试过爆炸声，太吓人了。这里只要让人抬头，内容由语音说清。
 */
function chime(delay = 0): void {
  if (!ctx || ctx.state !== 'running') return;
  const notes = [784, 1046];     // G5 -> C6
  notes.forEach((f, i) => {
    const osc = ctx!.createOscillator();
    const vol = ctx!.createGain();
    osc.type = 'triangle';       // 比正弦亮一点，比方波柔和
    osc.frequency.value = f;
    const t = ctx!.currentTime + delay + i * 0.13;
    vol.gain.setValueAtTime(0, t);
    vol.gain.linearRampToValueAtTime(0.22, t + 0.015);
    vol.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(vol).connect(ctx!.destination);
    osc.start(t);
    osc.stop(t + 0.35);
  });
}

/** 没有中文语音时的兜底：多响两声，至少不会完全没提示 */
function fallbackTone(): void {
  chime(0);
  chime(0.5);
}

/* ---------------- 对外 ---------------- */

/** 必须在用户点击的事件处理里调用 */
export async function unlockAudio(): Promise<SoundStatus> {
  try {
    type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
    if (!Ctor) return 'blocked';
    if (!ctx) {
      ctx = new Ctor();
      /**
       * statechange 必须在**这里**挂，不能在 watchSoundStatus 里挂：
       * 订阅者（看门狗、开关）都在页面加载时就订阅了，那时 ctx 还是 null，
       * 挂不上任何东西，只能靠 15 秒轮询兜底 —— 音频被挂起要等最多 15 秒
       * 才发现。挂在这里就是即时的。
       */
      ctx.addEventListener('statechange', notifyWatchers);
    }
    if (ctx.state === 'suspended') await ctx.resume();

    await loadVoice();
    // iOS Safari 要求 speechSynthesis 首次调用发生在用户手势里，
    // 这里播一条空串把它激活，之后才能在收到报警时自动播报
    if (typeof speechSynthesis !== 'undefined' && cachedVoice) {
      try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* 忽略 */ }
    }
    chime();          // 让用户听见确认，否则无法验证真的能响
    notifyWatchers();
    return soundStatus();
  } catch {
    return 'blocked';
  }
}

/**
 * 收到暴涨报警时的提示。
 *
 * 档位不改变提示强度 —— 之前用爆炸次数区分档位，实际体验是被吓一跳，
 * 而具体涨了多少倍在通知和页面上都写着，不需要靠声音表达。
 *
 * 但**报警的种类**要能听出来：暴涨念「有东西暴涨了」，破新高念
 * 「有币创新高了」。都念同一句的话，光靠听分不出是哪一种，
 * 而这两件事该引起的反应不一样。
 */
export function playPumpSound(opts?: { phrase?: string }): void {
  /**
   * 被挂起就先试着唤醒。不带用户手势的 resume() 不保证成功 ——
   * 成功了这次报警照常响，失败了 watchSoundStatus 会把开关翻回
   * 「未开启」，让用户看见。两条路都好过安静地什么都不做。
   */
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().then(() => chime()).catch(() => { /* 唤不醒就靠横幅提示 */ });
  } else {
    chime();
  }
  // 让提示音先响完再说话，叠在一起会互相盖住
  setTimeout(() => {
    if (!speakPump(opts?.phrase)) fallbackTone();
  }, 300);
}

/* ---------------- 系统通知 ---------------- */

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * 暴涨通知在屏幕上停留多久。
 *
 * **Notification API 没有"显示时长"这个参数** —— 默认约 5 秒是系统定的，
 * 传什么都改不了。能做的是 requireInteraction 让它不自动滑走，再自己
 * 定时关掉，等效于指定时长。
 *
 * 不设 requireInteraction 的后果是实测过的：Windows 上弹五秒就滑进通知
 * 中心，人没盯着屏幕就完全错过 —— 用户那边攒了 18 条没看见的。
 */
const NOTIFY_HOLD_MS = 10_000;

export type NotificationFailureReason =
  | 'unsupported'
  | 'permission-default'
  | 'permission-denied'
  | 'constructor-failed';

export type NotificationAttempt =
  | { accepted: true; tag: string }
  | { accepted: false; tag: string; reason: NotificationFailureReason };

export interface NotifyPumpOptions {
  /** 必须由事件 id/seq 生成；标题不是稳定身份。 */
  tag?: string;
}

/**
 * 提交系统通知并如实返回浏览器 API 的结果。
 *
 * accepted=true 只表示浏览器接受了 Notification 构造调用，不宣称操作系统
 * 一定把横幅显示在屏幕上；accepted=false 必须由页面留下持久失败提示。
 */
export function notifyPump(
  title: string, body: string, options: NotifyPumpOptions = {},
): NotificationAttempt {
  const tag = options.tag ?? 'show-tools-alert';
  if (typeof Notification === 'undefined') {
    return { accepted: false, tag, reason: 'unsupported' };
  }
  if (Notification.permission === 'default') {
    return { accepted: false, tag, reason: 'permission-default' };
  }
  if (Notification.permission !== 'granted') {
    return { accepted: false, tag, reason: 'permission-denied' };
  }
  try {
    const n = new Notification(title, {
      body,
      // tag 由事件 id/seq 生成。同一事件重放时不会与别的同名币相撞。
      tag,
      renotify: true,
      requireInteraction: true,
      silent: true,             // 声音由页面自己的语音播报负责，别响两次
    } as NotificationOptions);
    // 点一下把页面调到前台，省得在一堆标签里翻
    n.onclick = () => { window.focus(); n.close(); };
    const closeTimer = setTimeout(() => { try { n.close(); } catch { /* 已经关了 */ } }, NOTIFY_HOLD_MS);
    // Node 测试环境不应因为浏览器通知的保留定时器额外等待 10 秒；浏览器
    // 的数字 timer 没有 unref，这个分支只会在 Node timer 对象存在时执行。
    if (typeof closeTimer === 'object' && closeTimer !== null && 'unref' in closeTimer) {
      (closeTimer as { unref: () => void }).unref();
    }
    return { accepted: true, tag };
  } catch {
    // 某些浏览器在非 https、权限状态异常或系统策略阻止时会抛。
    return { accepted: false, tag, reason: 'constructor-failed' };
  }
}
