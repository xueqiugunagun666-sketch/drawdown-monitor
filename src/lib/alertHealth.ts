/**
 * 报警通路的健康监测。
 *
 * 回答的问题是：**"如果现在有币暴涨，我真的会知道吗？"**
 *
 * 存在的理由是一次真实事故：9-03 用户网页一直开着，FLETCH 的 2 倍档报警
 * 也确实写进了库，但什么都没听见。事后查出两个各自都能造成这个结果的洞，
 * 共同点是**它们都不出声** —— 提示音哑了和行情很安静，长得一模一样。
 *
 * 所以这里的核心不是"检测"，是**升级通道必须与失效的通道不同**：
 * 提示音坏了就不能靠提示音提醒，页面横幅也一样 —— 人正是因为听不见
 * 才没在看页面。能用的只剩系统通知（它的权限与音频自动播放策略是两套，
 * 音频被挂起时通知照样能弹）和标签页的标题/图标（切到别的标签也看得见）。
 *
 * **说清楚做不到的**：网页整个关掉之后这里什么也做不了，那需要服务端
 * 推送通道（Telegram 之类），是另一件事。
 */

/** 会让报警完全无声的故障。每一条都单独判、单独提醒 */
export type HealthIssue =
  | 'audio-dead'
  | 'stream-down'
  | 'backend-down'
  | 'alert-read-down';

/**
 * 报一次之前要持续这么久。
 *
 * 不是为了少打扰，是为了不误报：EventSource 断开后约 3 秒自动重连，
 * 网络抖一下就弹窗，弹几次之后用户就不看了 —— 那等于把这个功能关掉。
 */
export const GRACE_SECONDS = 15;

/** 一直不好的话，隔这么久再提醒一次。与报警去重窗口取同一个数 */
export const RENOTIFY_SECONDS = 1800;
export const BUSINESS_HEARTBEAT_TIMEOUT_SECONDS = 65;

export interface HealthSignals {
  audioReady: boolean;
  streamConnected: boolean;
  streamConnectedSince: number | null;
  businessHeartbeatAt: number | null;
  backendDown: boolean;
  alertReadDown: boolean;
}

export type BackendRuntimeStatus = 'unknown' | 'healthy' | 'degraded' | 'down';

/**
 * 只有整个判定循环失活或尚无任何健康证明时，才升级成红色系统故障弹窗。
 * 单链/单批次降级仍由页面黄条说明；把 degraded 当 down 会在回退正常工作时
 * 反复喊“后端已死”，最终让真正的宕机提醒失去可信度。
 */
export function shouldEscalateBackend(status: BackendRuntimeStatus): boolean {
  return status === 'down' || status === 'unknown';
}

/** 把浏览器与服务端信号统一翻译成看门狗故障项，便于回放边界。 */
export function healthIssuesForSignals(signals: HealthSignals, now: number): Set<HealthIssue> {
  const present = new Set<HealthIssue>();
  if (!signals.audioReady) present.add('audio-dead');
  if (!signals.streamConnected) present.add('stream-down');
  const heartbeatMissing = signals.streamConnected && (
    signals.businessHeartbeatAt === null
      ? signals.streamConnectedSince !== null
        && now - signals.streamConnectedSince > BUSINESS_HEARTBEAT_TIMEOUT_SECONDS
      : now - signals.businessHeartbeatAt > BUSINESS_HEARTBEAT_TIMEOUT_SECONDS
  );
  if (signals.streamConnected && (signals.backendDown || heartbeatMissing)) present.add('backend-down');
  if (signals.streamConnected && signals.alertReadDown) present.add('alert-read-down');
  return present;
}

export interface IssueState {
  /**
   * 这一项**曾经正常过**。
   *
   * 关键的一条：从没开启过声音不算"失效"，那是还没配置，页面上本来就有
   * 醒目横幅在说，而且那时候通知权限多半也还没给、根本弹不出来。
   * 只有"本来好好的，现在坏了"才值得打断人。
   */
  everHealthy: boolean;
  /** 这次出问题是从什么时候开始的。null = 现在没问题 */
  since: number | null;
  /** 上次为这一项提醒过的时刻 */
  lastNotifiedAt: number | null;
}

export type WatchState = Record<HealthIssue, IssueState>;

export const ISSUES: HealthIssue[] = [
  'audio-dead', 'stream-down', 'backend-down', 'alert-read-down',
];

/** 音频没开启是常态；其余通道从页面打开起就应该在观察期后可用。 */
function requiresPriorHealthy(issue: HealthIssue): boolean {
  return issue === 'audio-dead';
}

export function initialWatchState(): WatchState {
  return {
    'audio-dead': { everHealthy: false, since: null, lastNotifiedAt: null },
    'stream-down': { everHealthy: false, since: null, lastNotifiedAt: null },
    'backend-down': { everHealthy: false, since: null, lastNotifiedAt: null },
    'alert-read-down': { everHealthy: false, since: null, lastNotifiedAt: null },
  };
}

export interface StepResult {
  state: WatchState;
  /** 本次要弹窗提醒的项。空数组表示什么都不用做 */
  notify: HealthIssue[];
}

/**
 * 推进一步。纯函数 —— 时间从外面传进来，好测。
 *
 * @param present 此刻存在的故障
 */
export function step(prev: WatchState, present: Set<HealthIssue>, now: number): StepResult {
  const state = {} as WatchState;
  const notify: HealthIssue[] = [];

  for (const issue of ISSUES) {
    const p = prev[issue];

    if (!present.has(issue)) {
      // 恢复了：记下"曾经正常过"，并把计时与提醒记录清零，
      // 这样下次再坏会立刻重新提醒，而不是被上次的去重窗口压着
      state[issue] = { everHealthy: true, since: null, lastNotifiedAt: null };
      continue;
    }

    const since = p.since ?? now;
    const held = now - since >= GRACE_SECONDS;
    const due = p.lastNotifiedAt === null || now - p.lastNotifiedAt >= RENOTIFY_SECONDS;

    if ((!requiresPriorHealthy(issue) || p.everHealthy) && held && due) {
      notify.push(issue);
      state[issue] = { everHealthy: p.everHealthy, since, lastNotifiedAt: now };
    } else {
      state[issue] = { everHealthy: p.everHealthy, since, lastNotifiedAt: p.lastNotifiedAt };
    }
  }

  return { state, notify };
}

/**
 * 当前处于故障中的项，用来决定标签页要不要示警。
 *
 * 与提醒守同一条规则，**包括 everHealthy**：从没配置过不算失效。
 * 少了这一条，每次刷新页面标签栏都会红着（浏览器要求每次加载都重新
 * 点一下才允许出声），红久了就没人看了 —— 那等于把这个告警关掉。
 * 「还没开启」是页面里那个大黄横幅的活，不是标签页告警的活。
 */
export function activeIssues(state: WatchState, now: number): HealthIssue[] {
  return ISSUES.filter((i) => {
    const s = state[i];
    return (!requiresPriorHealthy(i) || s.everHealthy)
      && s.since !== null && now - s.since >= GRACE_SECONDS;
  });
}

/** 弹窗与横幅的文案。必须说清楚"因此你会漏掉什么"，不能只说"出错了" */
export function describeIssue(issue: HealthIssue): { title: string; body: string } {
  switch (issue) {
    case 'audio-dead':
      return {
        title: '暴涨提示音已失效',
        body: '浏览器把音频挂起了（切到后台或系统休眠之后常见）。'
          + '现在有币暴涨也不会出声，回到监控页点一下「开启声音」恢复。',
      };
    case 'stream-down':
      return {
        title: '实时推送已断开',
        body: '断开期间的暴涨不会播报。正在自动重连，重连后会把漏掉的补上；'
          + '一直不恢复就刷新一下页面。',
      };
    case 'backend-down':
      return {
        title: '暴涨监测后端可能已失活',
        body: '网页连接仍可能显示正常，但后台没有按时完成行情轮次或业务心跳已中断。'
          + '恢复前可能漏掉暴涨与新高提醒。',
      };
    case 'alert-read-down':
      return {
        title: '报警记录读取失败',
        body: '浏览器连接仍在，但服务端暂时读不到新报警。游标没有推进，恢复后会补发；'
          + '故障期间提醒可能延迟。',
      };
  }
}
