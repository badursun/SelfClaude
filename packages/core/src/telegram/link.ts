import { randomInt } from 'node:crypto';
import { Bot } from 'grammy';
import { ENV_PATH, setEnvVar } from '../lib/env.js';
import { log } from '../lib/log.js';

/**
 * 8-character alphanumeric pairing code drawn from a CSPRNG.
 * Character set: 0-9, A-Z (36 chars) → 36^8 ≈ 2.8 trillion ≈ 47 bits of entropy.
 * Upgraded from 6-digit numeric (20 bits) to address CWE-332 concern.
 */
export function generatePairingCode(): string {
  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += CHARS[randomInt(0, 36)]!;
  }
  return code;
}

export interface LinkResult {
  chatId: string;
  username?: string | undefined;
  botUsername?: string | undefined;
}

/**
 * Interactive Telegram pairing flow. Starts the bot in long-poll mode, prints
 * a 6-digit code, and waits for the user to send that exact code from their
 * personal chat with the bot. On success: persists `TELEGRAM_CHAT_ID` to .env
 * and stops the bot.
 *
 * The CLI command (`selfclaude link-telegram`) wraps this. The function is
 * also unit-testable by passing in a custom bot factory.
 */
export async function runLinkFlow(
  token: string,
  io: {
    log: (msg: string) => void;
    persistChatId?: (chatId: string) => Promise<void>;
  } = { log: (m) => process.stdout.write(`${m}\n`) },
): Promise<LinkResult> {
  const bot = new Bot(token);
  const me = await bot.api.getMe();
  io.log('');
  io.log(`Bot @${me.username ?? '?'} is online.`);
  const code = generatePairingCode();
  io.log('');
  io.log(`Pairing code: ${code}`);
  io.log('');
  if (me.username) {
    io.log(`Open https://t.me/${me.username} and send this code as a plain message.`);
  } else {
    io.log('Open the bot in Telegram and send this code as a plain message.');
  }
  io.log('');
  io.log('Waiting for the code… (Ctrl+C to cancel)');
  io.log('');

  const result = await new Promise<LinkResult>((resolve, reject) => {
    bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (text === code) {
        await ctx.reply('✓ Paired with SelfClaude. You can return to your terminal.');
        resolve({
          chatId: String(ctx.chat.id),
          username: ctx.from?.username,
          botUsername: me.username,
        });
      } else {
        await ctx.reply(`That doesn't match the pairing code. Send: ${code}`);
      }
    });
    bot
      .start({ drop_pending_updates: true })
      .catch((e) => reject(new Error(`bot.start failed: ${(e as Error).message}`)));
  });

  await bot.stop();

  const persist = io.persistChatId ?? ((chatId: string) => setEnvVar(ENV_PATH, 'TELEGRAM_CHAT_ID', chatId));
  await persist(result.chatId);
  log('info', 'telegram.linked', { chatId: result.chatId, username: result.username });
  io.log('');
  io.log(`✓ Saved TELEGRAM_CHAT_ID=${result.chatId} to ${ENV_PATH}`);
  if (result.username) io.log(`  Linked to @${result.username}`);
  return result;
}
