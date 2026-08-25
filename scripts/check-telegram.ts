/**
 * Telegram 配置自检 —— 只调只读接口，不发任何消息。
 *   npm run check:telegram
 */
import { httpGet } from '../src/lib/http.ts';
import { getSecrets } from '../src/lib/config.ts';
import { mask, scrubSecrets } from '../src/lib/mask.ts';

const { telegramBotToken: token, telegramChatId: chatId } = getSecrets();

console.log(`TELEGRAM_BOT_TOKEN = ${mask(token)}`);
console.log(`TELEGRAM_CHAT_ID   = ${mask(chatId)}`);
console.log();

if (!token || !chatId) {
  console.error('未配置，无法检查。');
  process.exit(1);
}

async function call(method: string): Promise<Record<string, unknown> | null> {
  const res = await httpGet(`https://api.telegram.org/bot${token}/${method}`, 15_000);
  let parsed: { ok?: boolean; result?: Record<string, unknown>; description?: string };
  try {
    parsed = JSON.parse(res.body);
  } catch {
    console.error(`  ${method}: 响应不是合法 JSON（HTTP ${res.status}）`);
    return null;
  }
  if (!parsed.ok) {
    // description 可能回显 URL，统一过掩码
    console.error(`  ${method} 失败: ${scrubSecrets(parsed.description ?? `HTTP ${res.status}`)}`);
    return null;
  }
  return parsed.result ?? {};
}

const me = await call('getMe');
if (me) {
  console.log(`Bot 有效: @${me.username} (${me.first_name})`);
  console.log(`  可加入群组: ${me.can_join_groups ? '是' : '否'}`);
} else {
  console.error('Bot token 无效 —— 去 @BotFather 用 /mybots 重新取一个。');
  process.exit(1);
}

console.log();
const chat = await call(`getChat?chat_id=${encodeURIComponent(chatId)}`);
if (chat) {
  console.log(`会话有效: ${chat.title ?? chat.username ?? chat.id}  (type=${chat.type})`);
  console.log('\n配置正常，报警会推到这里。');
} else {
  console.error('\n拿不到该会话。常见原因：');
  console.error('  1. bot 还没被拉进这个群');
  console.error('  2. 群 ID 不对 —— 超级群的 ID 通常形如 -100xxxxxxxxxx');
  console.error('  3. bot 在群里但没有读取权限（BotFather 里关掉 Privacy Mode，或给它管理员）');
  process.exit(1);
}
