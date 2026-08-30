/**
 * 配色校验：色差与对比度，含色觉缺陷模拟。
 *
 * 深色界面上靠眼睛挑颜色不可靠 —— 半透明叠加会被底色吃掉，
 * 两个"看起来不一样"的色在红绿色盲下可能完全同色。这里量化。
 *
 * ΔE 用 CIE76（够用来发现碰撞，不追求感知均匀的精确度）；
 * 色觉模拟用 Machado 2009 的矩阵近似。
 */
type RGB = [number, number, number];

const hex = (h: string): RGB => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const unlin = (c: number) => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

function luminance(c: RGB): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
function contrast(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function toLab(c: RGB): [number, number, number] {
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toLab(a), [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Machado 2009 severity=1.0 矩阵 */
const CVD: Record<string, number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};
function simulate(c: RGB, kind: string): RGB {
  const m = CVD[kind]!;
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  return [
    unlin(m[0]! * r + m[1]! * g + m[2]! * b),
    unlin(m[3]! * r + m[4]! * g + m[5]! * b),
    unlin(m[6]! * r + m[7]! * g + m[8]! * b),
  ];
}

const BG = hex('#0a0a0a');
const EXISTING: Record<string, string> = {
  '回撤警告黄': '#fab219', '回撤严重红': '#d03b3b', '走势线蓝': '#3987e5',
};
const CANDIDATES: Record<string, string> = {
  '2x 中性': process.argv[2] ?? '#d4d4d4',
  '5x 绿': process.argv[3] ?? '#3fbf7f',
  '10x 亮绿': process.argv[4] ?? '#7ef2b4',
};

console.log('=== 与背景 #0a0a0a 的对比度（正文需 >= 4.5:1，大字需 >= 3:1）===');
for (const [n, h] of Object.entries(CANDIDATES)) {
  const r = contrast(hex(h), BG);
  console.log(`  ${n.padEnd(10)} ${h}  ${r.toFixed(2)}:1  ${r >= 4.5 ? '✓' : r >= 3 ? '△ 仅大字' : '✗'}`);
}

console.log('\n=== 候选之间的区分度（同页并列，ΔE 需 >= 15）===');
const cs = Object.entries(CANDIDATES);
for (let i = 0; i < cs.length; i++) {
  for (let j = i + 1; j < cs.length; j++) {
    const [na, ha] = cs[i]!, [nb, hb] = cs[j]!;
    const vals = ['正常', 'protan', 'deutan', 'tritan'].map((k) => ({
      k, d: k === '正常' ? deltaE(hex(ha), hex(hb)) : deltaE(simulate(hex(ha), k), simulate(hex(hb), k)),
    }));
    const worst = vals.reduce((m, v) => (v.d < m.d ? v : m));
    console.log(`  ${na} vs ${nb}: 最差 ΔE ${worst.d.toFixed(1)} (${worst.k})  ${worst.d >= 15 ? '✓' : worst.d >= 10 ? '△' : '✗'}`);
  }
}

console.log('\n=== 与既有配色的碰撞（跨页面，ΔE 需 >= 15）===');
for (const [cn, ch] of cs) {
  for (const [en, eh] of Object.entries(EXISTING)) {
    const vals = ['正常', 'protan', 'deutan', 'tritan'].map((k) => ({
      k, d: k === '正常' ? deltaE(hex(ch), hex(eh)) : deltaE(simulate(hex(ch), k), simulate(hex(eh), k)),
    }));
    const worst = vals.reduce((m, v) => (v.d < m.d ? v : m));
    const flag = worst.d >= 15 ? '✓' : worst.d >= 10 ? '△' : '✗';
    if (flag !== '✓') console.log(`  ${cn} vs ${en}: 最差 ΔE ${worst.d.toFixed(1)} (${worst.k})  ${flag}`);
  }
}
console.log('  （只列出不合格的；未列出即全部通过）');
