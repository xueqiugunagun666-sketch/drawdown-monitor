import LoginForm from './LoginForm.tsx';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <h1 className="text-lg font-semibold mb-1">回撤监控</h1>
      <p className="text-xs text-neutral-500 mb-6">需要口令</p>
      <LoginForm />
    </main>
  );
}
