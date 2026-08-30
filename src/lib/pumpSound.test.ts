import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVoice, PUMP_PHRASE } from './pumpSound.ts';

const v = (name: string, lang: string) => ({ name, lang } as SpeechSynthesisVoice);

test('播报内容就是这句', () => {
  assert.equal(PUMP_PHRASE, '有东西暴涨了');
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
