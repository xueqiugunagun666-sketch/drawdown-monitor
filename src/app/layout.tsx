import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '回撤监控',
  description: '多链代币回撤监控与抄底报警',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
