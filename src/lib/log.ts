/**
 * 结构化日志。所有输出都过 scrubSecrets —— 这是控制台的唯一出口。
 */
import { scrubSecrets, safeErrorMessage } from './mask.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>) {
  const line = scrubSecrets(`[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${msg}`);
  const payload = extra ? scrubSecrets(JSON.stringify(extra)) : '';
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(payload ? `${line} ${payload}` : line);
}

export function makeLogger(scope: string) {
  return {
    debug: (m: string, e?: Record<string, unknown>) => emit('debug', scope, m, e),
    info: (m: string, e?: Record<string, unknown>) => emit('info', scope, m, e),
    warn: (m: string, e?: Record<string, unknown>) => emit('warn', scope, m, e),
    error: (m: string, e?: Record<string, unknown>) => emit('error', scope, m, e),
    /** 记录异常，永远不吞掉 —— 规则 4：静默失效比误报危险 */
    exception: (m: string, err: unknown, e?: Record<string, unknown>) =>
      emit('error', scope, `${m}: ${safeErrorMessage(err)}`, e),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
