import Nav from '../../components/Nav.tsx';
import AddForm from './AddForm.tsx';

export const dynamic = 'force-dynamic';

export default function AddPage() {
  return (
    <main className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <Nav current="/add" />
      <h1 className="text-xl font-semibold mb-1">加币</h1>
      <p className="text-xs text-neutral-500 mb-5">添加后 worker 下一轮会自动取价并开始回填 90 天历史</p>
      <AddForm />
    </main>
  );
}
