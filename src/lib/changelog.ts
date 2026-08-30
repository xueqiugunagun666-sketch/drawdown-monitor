/**
 * 版本记录。
 *
 * 唯一的事实来源就是这个文件 —— 加新版本往数组开头插一条。
 * 版本号按用户能感知的变化划分，不按提交数：
 * 大版本 = 新增一整块能力，小版本 = 在已有能力上的改进与修复。
 */
export interface Change {
  kind: 'new' | 'fix' | 'change';
  title: string;
  detail?: string;
}

export interface Release {
  version: string;
  date: string;          // YYYY-MM-DD
  headline: string;
  changes: Change[];
}

export const RELEASES: Release[] = [
  {
    version: 'v2.1',
    date: '2026-08-31',
    headline: '报警终于说得清是哪个币',
    changes: [
      {
        kind: 'change',
        title: '提示音改成中文语音播报',
        detail: '之前试过爆炸声，太吓人了。现在是一声柔和的提示音，接着播报「有东西暴涨了」。设备上没有中文语音的，页面会明说，不会让你以为在播报其实没有。',
      },
      {
        kind: 'new',
        title: '一眼看出是哪个币暴涨',
        detail: '最新报警放在页面最顶上的绿色横幅，写清币名、倍数、从多少涨到多少。一小时内报过警的持仓整行标绿并排到最前，点横幅直接跳过去。之前这里显示的是一串合约地址，等于没说。',
      },
      {
        kind: 'new',
        title: '持仓列表显示当前涨幅',
        detail: '按涨幅从高到低排，2 倍以上转绿、5 倍以上更亮。不用等报警就知道什么在动 —— 因为系统不补报你加钱包之前的涨幅，只看报警记录的话，一个已经涨了三倍的币是完全看不见的。',
      },
      {
        kind: 'new',
        title: '空投诈骗币自动过滤',
        detail: '持有人超过 10 万的币不再监控。这类币是白送到钱包里的，持有人虚高、盘子是假的。实测挡下 132 个，排前面的名字本身就是广告，有个甚至用西里尔字母冒充 USDC。',
      },
      {
        kind: 'change',
        title: '钱包一次填一个地址，四条链一起监控',
        detail: '四条链都是 EVM，同一个私钥在每条链上都是同一个地址。以前要一条链填一次，纯属折磨。',
      },
      {
        kind: 'new',
        title: '代币显示名字而不是合约地址',
        detail: '之前 857 条持仓里 851 条只有一串十六进制。合约地址仍然显示在名字后面，点一下复制 —— 同名假币多，最终认的还是它。',
      },
      {
        kind: 'fix',
        title: '四类假报警',
        detail: '包括一条真的推送出去的 5.96×10²¹ 倍。原因是行情源偶尔给出离谱价格，或两个数据源对同一个币用了不同口径。现在入口有守卫，低点计算也不再被单个异常值带偏。',
      },
      {
        kind: 'fix',
        title: '注册没反应',
        detail: '之前注册其实每次都成功了，但页面既不提示也不跳转，看着像失败。现在会验证登录状态真的生效，成功有提示，失败会说清原因。',
      },
    ],
  },
  {
    version: 'v2.0',
    date: '2026-08-30',
    headline: '钱包异动监控',
    changes: [
      {
        kind: 'new',
        title: '填一次地址，自动盯住你所有持仓',
        detail: '按你的地址在链上过滤转账记录找出持有的代币，再读余额。以太坊 / BSC / Base / Robinhood 四条链。',
      },
      {
        kind: 'new',
        title: '暴涨到 2 / 5 / 10 倍时用声音叫你',
        detail: '四个时间窗口同时算（5 分钟 / 1 小时 / 6 小时 / 24 小时），从低点和从起点两种口径。同一波行情只报一条。',
      },
      {
        kind: 'new',
        title: '个人账号，持仓互不可见',
        detail: '钱包区在全站口令之上再要一次个人登录。你的钱包和持仓，其他人看不到。',
      },
      {
        kind: 'new',
        title: '流动性与成交量门槛',
        detail: '实测一个活跃地址能扫出七千多个代币，有价格的不到 5%。不过滤的话，真正重要的报警会被垃圾淹没。被挡掉的币会写明具体数字，不会静静消失。',
      },
    ],
  },
  {
    version: 'v1.5',
    date: '2026-08-29',
    headline: '看板重做',
    changes: [
      { kind: 'change', title: '视觉层级重排，手机上可用' },
      { kind: 'new', title: '每个代币加迷你走势图' },
      {
        kind: 'new',
        title: '置顶高亮',
        detail: '有些币还没跌下来但你想盯着，可以置顶。用亮度而不是颜色标记 —— 色相位已经被跌幅的黄红和走势线的蓝占满了。',
      },
    ],
  },
  {
    version: 'v1.4',
    date: '2026-08-26',
    headline: '项目日历与署名',
    changes: [
      {
        kind: 'new',
        title: '项目日历',
        detail: 'mint、发行、上所的时间点，带时区换算与提前提醒。',
      },
      { kind: 'new', title: '加币和加日程会记下是谁加的' },
      {
        kind: 'fix',
        title: '新加的币若已跌破阈值会连推多档',
        detail: '一个加进来时就已经跌了 91% 的币，会隔 30 分钟连推 75%、80%、85% 三条。现在加入时已达标的档位直接置为「已报过」，不补报历史跌幅。',
      },
    ],
  },
  {
    version: 'v1.3',
    date: '2026-08-25',
    headline: '回填提速二十倍',
    changes: [
      {
        kind: 'change',
        title: '历史数据改走 GMGN',
        detail: 'GeckoTerminal 免费档只有 5 次/分钟，全量回填要跑十几个小时。换成 GMGN 后快二十倍，GT 退为兜底。',
      },
      { kind: 'new', title: '报警里加上市值回撤与合约地址' },
      {
        kind: 'fix',
        title: '历史最高价低于 90 天最高价',
        detail: '1 小时 K 线会漏掉小时内的尖峰。改成取两者的最大值。',
      },
    ],
  },
  {
    version: 'v1.2',
    date: '2026-08-25',
    headline: '搬上网页，部署上线',
    changes: [
      { kind: 'new', title: '加币、改备注、删除、设置、报警历史全部搬到网页', detail: '不用再开终端。' },
      { kind: 'new', title: '登录鉴权与服务器部署' },
      {
        kind: 'fix',
        title: '一条 -100% 的假报警',
        detail: '两个数据源对同一个池子的交易对方向判断不一致，回填时取到了另一个代币的价格，差了一万六千倍。',
      },
    ],
  },
  {
    version: 'v1.1',
    date: '2026-08-25',
    headline: '数据准确性',
    changes: [
      { kind: 'new', title: 'OHLCV 历史回填，报警不再只看当下' },
      {
        kind: 'new',
        title: '三种最高价口径与原生币计价',
        detail: '90 天滚动 / 加入以来 / 全部历史，可分别设定。',
      },
      { kind: 'new', title: '多档位报警与代币详情页' },
    ],
  },
  {
    version: 'v1.0',
    date: '2026-08-25',
    headline: '回撤监控上线',
    changes: [
      { kind: 'new', title: '多链代币价格轮询与回撤判定' },
      { kind: 'new', title: '跌破阈值时推送 Telegram' },
      { kind: 'new', title: '网页看板' },
    ],
  },
];

/** 最新版本号，给按钮上的角标用 */
export const CURRENT_VERSION = RELEASES[0]?.version ?? 'v1.0';
