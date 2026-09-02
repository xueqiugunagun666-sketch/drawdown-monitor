/**
 * 当前账号。有了真身份之后，原来那个自填署名输入框就是纯冒充面，
 * 已经删掉 —— 名字现在由服务端从会话取，改不了。
 */
export default function UserBadge({ name, isAdmin }: { name: string | null; isAdmin: boolean }) {
  if (!name) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-500">
      {name}
      {isAdmin && (
        <span className="rounded px-1 py-0.5 text-[10px] bg-neutral-800 text-neutral-400">管理员</span>
      )}
    </span>
  );
}
