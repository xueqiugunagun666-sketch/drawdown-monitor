/**
 * 权限判定 —— 纯函数，不碰数据库也不碰 Request。
 *
 * 抽出来是为了能穷举测试。混在路由里的话，「管理员能不能删无主的」
 * 这种问题就得起一个 HTTP 请求才能验证，实际上没人会去验。
 *
 * 三条规则对应三个函数，不要合成一个带 action 参数的万能函数 ——
 * 那样调用点看不出在判什么，加一个动作就要改所有分支。
 */
export interface Actor {
  id: string;
  name: string;
  isAdmin: boolean;
}

/** 归属为 null（或空串）= 无主，只有管理员能动 */
function owns(actor: Actor, ownerId: string | null | undefined): boolean {
  return !!ownerId && ownerId === actor.id;
}

/** 删除：管理员删任何，其他人只删自己加的 */
export function canDelete(actor: Actor | null, ownerId: string | null | undefined): boolean {
  if (!actor) return false;
  return actor.isAdmin || owns(actor, ownerId);
}

/** 改备注/标签：与删除同规则。备注记录的是添加者的判断，别人改掉就丢了上下文 */
export function canEditMeta(actor: Actor | null, ownerId: string | null | undefined): boolean {
  if (!actor) return false;
  return actor.isAdmin || owns(actor, ownerId);
}

/** 停用/冻结/改报警档位：全局生效，只有管理员 */
export function canToggleGlobal(actor: Actor | null): boolean {
  return !!actor?.isAdmin;
}
