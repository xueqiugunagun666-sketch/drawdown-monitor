import type { Config } from 'tailwindcss';
export default {
  // 必须覆盖整个 src：severity.ts 这类工具模块里也会写 class 名，
  // 漏掉的话 Tailwind 会把它们当未使用清除，颜色静默失效
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
