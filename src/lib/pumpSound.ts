/**
 * 暴涨提示音与系统通知。
 *
 * 两个绕不过去的浏览器限制：
 *
 * 1. **禁止未经交互的自动播放。** AudioContext 必须在一次真实点击的
 *    事件处理里创建并 resume。所以要有显式的"开启声音"开关，
 *    而且换设备、清缓存后要重新点。
 *
 * 2. **状态必须显眼。** 用户以为开着、其实没声音，是这个功能最危险的
 *    失效方式 —— 比误报危险得多，因为它是静默的（第 4 条铁律）。
 *
 * 声音用 AudioContext 现场合成，不加音频文件：省掉打包体积，
 * 也省掉"文件加载失败但页面没报错"这一类静默故障。
 */
export type SoundStatus = 'locked' | 'ready' | 'blocked';

let ctx: AudioContext | null = null;

export function soundStatus(): SoundStatus {
  if (!ctx) return 'locked';
  return ctx.state === 'running' ? 'ready' : 'blocked';
}

/** 必须在用户点击的事件处理里调用 */
export async function unlockAudio(): Promise<SoundStatus> {
  try {
    type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
    if (!Ctor) return 'blocked';
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') await ctx.resume();
    // 出一声极轻的确认音，让用户知道确实通了 ——
    // 只把状态改成"已开启"而不出声，用户无法验证它真的能响
    beep(880, 0.08, 0.04);
    return soundStatus();
  } catch {
    return 'blocked';
  }
}

function beep(freq: number, seconds: number, gain: number, delay = 0): void {
  if (!ctx || ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t = ctx.currentTime + delay;
  // 直接切断会有"咔"的爆音，加个短包络
  vol.gain.setValueAtTime(0, t);
  vol.gain.linearRampToValueAtTime(gain, t + 0.01);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  osc.connect(vol).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}

/**
 * 上行三音，档位越高音越多。
 * 用音数而不是音高区分档位 —— 音高差在小喇叭上不好分辨，数得清个数。
 */
export function playPumpSound(level: number): void {
  const notes = level >= 10 ? [660, 880, 1175, 1568] : level >= 5 ? [660, 880, 1175] : [660, 880];
  notes.forEach((f, i) => beep(f, 0.18, 0.12, i * 0.11));
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notifyPump(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    // tag 让同一个币的连续通知互相替换，不堆成一列
    new Notification(title, { body, tag: title, silent: true });
  } catch { /* 某些浏览器在非 https 下会抛 */ }
}
