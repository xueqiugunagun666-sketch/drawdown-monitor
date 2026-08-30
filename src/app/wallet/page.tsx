import Nav from '../../components/Nav.tsx';
import WalletClient from './WalletClient.tsx';

export const dynamic = 'force-dynamic';

export default function WalletPage() {
  return (
    <main className="mx-auto max-w-5xl p-4">
      <Nav current="/wallet" />
      <WalletClient />
    </main>
  );
}
