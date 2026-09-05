/**
 * 判断这个页面是不是在跑旧代码。
 *
 * 一直开着的页面在部署之后会**静默地继续用旧 JS**：SSE 连着不断、报警
 * 照收，只是渲染用的是老代码。2026-09-05 就这么骗过一次 —— ATH 报警
 * 明明改成了「破历史新高 · 前高立于 113 天前」，用户收到的还是
 * 「暴涨 1.1x · 0x 档」，差点被当成代码 bug 去查。
 *
 * 判据：服务端的版本号是**运行时读的**（新鲜），客户端手里那个是**打包时
 * 烙进去的**（可能很旧）。两者不一致就说明页面该刷新了。
 */

export function shouldPromptReload(
  serverVersion: string | undefined | null, clientVersion: string,
): boolean {
  // 拿不到服务端版本就不提示 —— 宁可不提醒，也不要因为一次字段缺失
  // 就让所有人看到一个假的"有新版本"
  if (!serverVersion) return false;
  return serverVersion !== clientVersion;
}
