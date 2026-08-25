/**
 * 数据源失败的显式类型。
 *
 * 规格 §4.4 / 绝对规则 4：静默失效比误报危险。
 * 关键约定 —— **空响应不等于"无报价"**：
 * Phase 0 实测 DexScreener 会间歇性返回 `[]` 且 HTTP 200、无 error 字段，
 * 也会在结果超过 30 条时静默丢弃多余代币。若把这些当成"该代币没有价格"，
 * 系统会安静地停止报警。因此适配器必须抛 SourceError，由调用方计入
 * consecutive_failures 并暴露到 UI。
 */

export type SourceFailureKind =
  | 'http_error'
  | 'empty_response'      // HTTP 200 但返回空数组
  | 'partial_response'    // 返回了，但请求的地址没有全覆盖
  | 'malformed'
  | 'rate_limited'
  | 'network';

export class SourceError extends Error {
  readonly sourceId: string;
  readonly kind: SourceFailureKind;
  readonly chain: string | undefined;
  /** 本次请求中没拿到数据的代币/池标识 */
  readonly missing: string[];

  constructor(opts: {
    sourceId: string;
    kind: SourceFailureKind;
    message: string;
    chain?: string;
    missing?: string[];
  }) {
    super(opts.message);
    this.name = 'SourceError';
    this.sourceId = opts.sourceId;
    this.kind = opts.kind;
    this.chain = opts.chain;
    this.missing = opts.missing ?? [];
  }
}

export class NotifyError extends Error {
  readonly channel: string;
  constructor(channel: string, message: string) {
    super(message);
    this.name = 'NotifyError';
    this.channel = channel;
  }
}
