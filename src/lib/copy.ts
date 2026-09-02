/**
 * 复制到剪贴板，带降级。
 *
 * navigator.clipboard.writeText 会在几种常见情况下抛错：
 * 非 https、窗口没有焦点、用户拒绝了权限。直接吞掉的话，
 * 用户点了按钮什么也没发生，还以为复制成功了 —— 拿着空剪贴板
 * 去交易所粘贴才发现，那时已经晚了。
 *
 * 失败时退回"选中那段文本"，用户长按或 Ctrl+C 仍能复制，
 * 并且看得见发生了什么。
 */
export async function copyText(text: string, fallbackElementId?: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackElementId) selectElementText(fallbackElementId);
    return false;
  }
}

function selectElementText(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  selectElement(el);
}

/**
 * 按元素引用选中，供"复制失败 → 先把地址渲染出来 → 再选中"这种两步场景。
 *
 * 这种场景不能用上面按 id 找的版本：元素是在失败之后才渲染的，
 * 而 React 的提交时机（调度器走 MessageChannel）与 setTimeout(0)
 * 谁先执行没有保证 —— 抢在提交前查就是 getElementById 返回 null，
 * 然后静默什么也不做。调用方拿 ref 在 useEffect 里调这个，
 * 元素必定已经在 DOM 里。
 */
export function selectElement(el: Element): void {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch { /* 选区 API 也不可用就只能作罢 */ }
}
