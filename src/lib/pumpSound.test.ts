import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  notifyPump, pickVoice, PUMP_PHRASE, MIXED_ALERT_PHRASE, SYSTEM_AND_MARKET_PHRASE,
} from './pumpSound.ts';

const v = (name: string, lang: string) => ({ name, lang } as SpeechSynthesisVoice);
const globalWithNotification = globalThis as Record<string, unknown>;
const originalNotification = globalWithNotification.Notification;

function installNotification(value: unknown): void {
  Object.defineProperty(globalWithNotification, 'Notification', {
    configurable: true, writable: true, value,
  });
}

function restoreNotification(): void {
  if (originalNotification === undefined) delete globalWithNotification.Notification;
  else installNotification(originalNotification);
}

test('播报内容就是这句', () => {
  assert.equal(PUMP_PHRASE, '有东西暴涨了');
  assert.equal(MIXED_ALERT_PHRASE, '有币暴涨或创新高了');
  assert.equal(SYSTEM_AND_MARKET_PHRASE, '监控系统有情况，行情也有异动');
});

test('优先挑中文女声', () => {
  const list = [v('Alex', 'en-US'), v('Eddy (中文（中国大陆）)', 'zh-CN'), v('婷婷', 'zh-CN')];
  assert.equal(pickVoice(list)?.name, '婷婷');
});

test('没有首选名字时退到任意 zh-CN', () => {
  const list = [v('Alex', 'en-US'), v('美嘉', 'zh-TW'), v('SomeVoice', 'zh-CN')];
  assert.equal(pickVoice(list)?.name, 'SomeVoice');
});

test('没有 zh-CN 时退到其它中文变体', () => {
  const list = [v('Alex', 'en-US'), v('美嘉', 'zh-TW')];
  assert.equal(pickVoice(list)?.name, '美嘉');
});

test('完全没有中文语音时返回 null —— 调用方要据此明确提示，不能静默降级', () => {
  assert.equal(pickVoice([v('Alex', 'en-US'), v('Daniel', 'en-GB')]), null);
  assert.equal(pickVoice([]), null);
});

test('语言标签大小写与分隔符不敏感', () => {
  assert.equal(pickVoice([v('X', 'ZH_CN')])?.name, 'X');
  assert.equal(pickVoice([v('Y', 'zh')])?.name, 'Y');
});

test('Windows 与 Android 的语音名也认得', () => {
  assert.equal(pickVoice([v('Microsoft Xiaoxiao Online', 'zh-CN'), v('Other', 'zh-CN')])?.name,
    'Microsoft Xiaoxiao Online');
  assert.equal(pickVoice([v('Other', 'zh-CN'), v('Google 普通话（中国大陆）', 'zh-CN')])?.name,
    'Google 普通话（中国大陆）');
});

test('没有 Notification API 时返回可见失败原因', () => {
  installNotification(undefined);
  try {
    assert.deepEqual(notifyPump('标题', '正文', { tag: 'event:a:1' }), {
      accepted: false, tag: 'event:a:1', reason: 'unsupported',
    });
  } finally {
    restoreNotification();
  }
});

test('权限尚未选择与明确拒绝会返回不同原因', () => {
  class PermissionDefaultNotification {
    static permission: NotificationPermission = 'default';
  }
  installNotification(PermissionDefaultNotification);
  try {
    assert.deepEqual(notifyPump('标题', '正文', { tag: 'event:b:1' }), {
      accepted: false, tag: 'event:b:1', reason: 'permission-default',
    });
  } finally {
    restoreNotification();
  }

  class PermissionDeniedNotification {
    static permission: NotificationPermission = 'denied';
  }
  installNotification(PermissionDeniedNotification);
  try {
    assert.deepEqual(notifyPump('标题', '正文', { tag: 'event:b:2' }), {
      accepted: false, tag: 'event:b:2', reason: 'permission-denied',
    });
  } finally {
    restoreNotification();
  }
});

test('Notification 构造成功时返回 accepted，并使用稳定 tag', () => {
  const instances: Array<{ title: string; options: NotificationOptions }> = [];
  class AcceptedNotification {
    static permission: NotificationPermission = 'granted';
    onclick: (() => void) | null = null;
    constructor(public title: string, public options: NotificationOptions) {
      instances.push({ title, options });
    }
    close(): void {}
  }
  installNotification(AcceptedNotification);
  try {
    const result = notifyPump('标题', '正文', { tag: 'event:c:3' });
    assert.deepEqual(result, { accepted: true, tag: 'event:c:3' });
    assert.equal(instances[0]?.options.tag, 'event:c:3');
  } finally {
    restoreNotification();
  }
});

test('Notification 构造抛错时返回 constructor-failed', () => {
  class ThrowingNotification {
    static permission: NotificationPermission = 'granted';
    constructor() { throw new Error('blocked'); }
  }
  installNotification(ThrowingNotification);
  try {
    assert.deepEqual(notifyPump('标题', '正文', { tag: 'event:d:4' }), {
      accepted: false, tag: 'event:d:4', reason: 'constructor-failed',
    });
  } finally {
    restoreNotification();
  }
});
