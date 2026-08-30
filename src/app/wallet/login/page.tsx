import Nav from '../../../components/Nav.tsx';
import AccountForm from './AccountForm.tsx';

export const dynamic = 'force-dynamic';

export default function WalletLoginPage() {
  return (
    <main className="mx-auto max-w-md p-4">
      <Nav current="/wallet" showBadge={false} />
      <AccountForm />
    </main>
  );
}
