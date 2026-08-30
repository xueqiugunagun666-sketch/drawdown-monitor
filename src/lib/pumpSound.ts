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
    if (!ctx) { ctx = new Ctor(); master = null; }
    if (ctx.state === 'suspended') await ctx.resume();
    // 出一声轻确认音，让用户知道确实通了 ——
    // 只把状态改成"已开启"而不出声，用户无法验证它真的能响。
    // 这里刻意不用爆炸声：开关按下就炸一下太吓人
    confirmBeep();
    return soundStatus();
  } catch {
    return 'blocked';
  }
}

/**
 * 软削波（tanh 饱和）+ 总输出增益。
 *
 * 三层叠加后峰值实测到 1.7，直接送 destination 就是硬削波 ——
 * 出来是刺耳的数字失真，不是"更响"而是"更难听"，音量开大时扎耳朵。
 * tanh 曲线把超出部分压回来，既不削波，听感上还比硬限幅更响
 * （波形更满，RMS 更高），而且爆炸声本来就该带点饱和感。
 */
let master: { input: GainNode } | null = null;
function getMaster(c: AudioContext): GainNode {
  if (master) return master.input;
  const input = c.createGain();
  input.gain.value = 1;
  const shaper = c.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.6);          // 1.6 是驱动量，越大越饱和
  }
  shaper.curve = curve;
  shaper.oversample = '4x';                  // 不加会有混叠，高频听着发毛
  const out = c.createGain();
  out.gain.value = 0.85;                     // 留 headroom，避免 tanh 输出仍贴到 1
  input.connect(shaper).connect(out).connect(c.destination);
  master = { input };
  return input;
}

/** 一次性生成的白噪声缓冲，爆炸声的主体 */
let noiseBuf: AudioBuffer | null = null;
function getNoise(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 2);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

/**
 * 一发爆炸。三层叠加：
 *   炸裂  —— 高通白噪声，30ms 内衰完，负责"啪"的那一下攻击感
 *   轰鸣  —— 低通白噪声，截止频率从 1200Hz 扫到 60Hz，负责尾巴
 *   低频冲击 —— 正弦从 110Hz 扫到 25Hz，负责胸口那一下
 *
 * 白噪声在同样增益下比正弦响得多（频谱宽），所以这个比原来的提示音
 * 响一个量级；而且宽频谱在手机小喇叭上也穿得透。
 */
function explode(c: AudioContext, at: number, power = 1): void {
  const dur = 0.9 * power;

  // 炸裂
  const crack = c.createBufferSource();
  crack.buffer = getNoise(c);
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2000;
  const crackGain = c.createGain();
  crackGain.gain.setValueAtTime(0.9 * power, at);
  crackGain.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
  crack.connect(hp).connect(crackGain).connect(getMaster(c));
  crack.start(at); crack.stop(at + 0.1);

  // 轰鸣
  const boom = c.createBufferSource();
  boom.buffer = getNoise(c);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1200, at);
  lp.frequency.exponentialRampToValueAtTime(60, at + dur);
  const boomGain = c.createGain();
  boomGain.gain.setValueAtTime(0.95 * power, at);
  boomGain.gain.exponentialRampToValueAtTime(0.001, at + dur);
  boom.connect(lp).connect(boomGain).connect(getMaster(c));
  boom.start(at); boom.stop(at + dur + 0.05);

  // 低频冲击
  const sub = c.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(110, at);
  sub.frequency.exponentialRampToValueAtTime(25, at + 0.45);
  const subGain = c.createGain();
  subGain.gain.setValueAtTime(0.85 * power, at);
  subGain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
  sub.connect(subGain).connect(getMaster(c));
  sub.start(at); sub.stop(at + 0.55);
}

/** 开启声音时的确认音 —— 轻一点，别把人吓着 */
function confirmBeep(): void {
  if (!ctx || ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;
  const t = ctx.currentTime;
  vol.gain.setValueAtTime(0, t);
  vol.gain.linearRampToValueAtTime(0.06, t + 0.01);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(vol).connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.15);
}

/**
 * 爆炸声。档位越高炸得越多、越猛。
 *
 * 用炸的**次数**而不是音色区分档位 —— 音色差别在手机小喇叭上分辨不出来，
 * 但"炸了三下"是数得清的。
 */
export function playPumpSound(level: number): void {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  if (level >= 10) {
    explode(ctx, t, 1.0);
    explode(ctx, t + 0.28, 0.9);
    explode(ctx, t + 0.62, 1.0);
  } else if (level >= 5) {
    explode(ctx, t, 1.0);
    explode(ctx, t + 0.32, 0.9);
  } else {
    explode(ctx, t, 0.85);
  }
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
