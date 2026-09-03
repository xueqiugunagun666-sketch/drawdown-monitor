import type { Metadata } from 'next';
import './globals.css';
import ChangelogButton from '../components/ChangelogButton.tsx';

export const metadata: Metadata = {
  title: 'Show Tools',
  description: '多链代币监控 —— 回撤抄底与暴涨提醒',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        {children}
        <ChangelogButton />
      </body>
    </html>
  );
}
