/**
 * 密钥掩码：前 4 后 4，中间一律 "..."。
 *
 * 规格 §11 要求日志、报错堆栈、前端响应中不得出现完整密钥。
 * 唯一出口是这里 —— 任何要打印/返回的字符串都应先过 scrubSecrets()。
 */

/** 运行时注册的敏感值，scrubSecrets 会在任意文本中替换它们 */
const registry = new Set<string>();

/** 掩码单个值：sk-abcdefgh1234wxyz -> sk-a...wxyz */
export function mask(value: string | undefined | null): string {
  if (value === undefined || value === null) return '<unset>';
  if (value.length === 0) return '<empty>';
  // 太短的值无法安全掩码，整体隐藏，避免泄漏出可暴力枚举的片段
  if (value.length < 12) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * 注册一个敏感值，之后 scrubSecrets 会把它从任意文本中抹掉。
 * 在读取 env 时调用。
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) registry.add(value);
}

/**
 * 把文本中所有已注册的密钥替换为掩码值。
 * 用于日志、错误消息、API 响应 —— 尤其是第三方 SDK 抛出的、
 * 可能把整个请求 URL（含 bot token）塞进 message 的异常。
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const secret of registry) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join(mask(secret));
    }
  }
  // Telegram bot token 形如 123456789:AAH... —— 即使未注册也兜底掩掉。
  // 不能加 \b：真实场景是 URL 里的 ".../bot123456789:AAH..."，
  // "t" 与 "1" 都是词字符，中间并没有词边界。
  out = out.replace(/(\d{6,12}):([A-Za-z0-9_-]{30,})/g, (_m, id: string, tok: string) =>
    `${id}:${mask(tok)}`,
  );
  return out;
}

/** 掩码后的错误消息，供日志与 API 响应使用 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubSecrets(raw);
}
