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
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch { /* 选区 API 也不可用就只能作罢 */ }
}
