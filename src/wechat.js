/**
 * wechat.js — WeChat iLink bot client (long-poll receive + send).
 *
 * Reuses the bot token saved by wechat-acp so the existing WeChat binding keeps
 * working without a new QR login. Only the small HTTP surface the bridge needs
 * is implemented here: getupdates, sendmessage, sendtyping, getconfig.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHANNEL_VERSION = '1.0.2';
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LONG_POLL_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MS = 30_000;
const RETRY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;

const MessageType = { USER: 1, BOT: 2 };
const MessageState = { FINISH: 2 };
const TypingStatus = { TYPING: 1, CANCEL: 2 };

function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

function headers(token) {
  const value = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) value.Authorization = `Bearer ${token}`;
  return value;
}

async function post(baseUrl, endpoint, body, token, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/${endpoint}`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ...body, base_info: { channel_version: CHANNEL_VERSION } }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`wechat ${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (error) {
    if (error?.name === 'AbortError') return { ret: 0, msgs: [] };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the saved bot token.
 * @param {string} storageDir - directory holding `token.json`.
 * @returns {{ token: string, baseUrl: string, accountId: string } | null}
 */
export function loadToken(storageDir) {
  const file = join(storageDir, 'token.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data?.token) return null;
    return { token: data.token, baseUrl: data.baseUrl || DEFAULT_BASE_URL, accountId: data.accountId ?? '' };
  } catch {
    return null;
  }
}

/** Persistent bridge state: per-user context tokens and binding. */
export class BridgeState {
  #file;
  #data;

  constructor(storageDir) {
    mkdirSync(storageDir, { recursive: true });
    this.#file = join(storageDir, 'bridge-state.json');
    try {
      this.#data = JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      this.#data = { users: {} };
    }
    if (!this.#data.users) this.#data.users = {};
  }

  /** @returns {{ contextToken?: string } | undefined} */
  user(userId) {
    return this.#data.users[userId];
  }

  rememberUser(userId, contextToken) {
    this.#data.users[userId] = { ...this.#data.users[userId], contextToken, lastSeenAt: new Date().toISOString() };
    this.#data.lastActiveUserId = userId;
    this.#save();
  }

  get lastActiveUserId() {
    return this.#data.lastActiveUserId;
  }

  #save() {
    try {
      writeFileSync(this.#file, JSON.stringify(this.#data, null, 2), 'utf8');
    } catch {
      /* state is best-effort */
    }
  }
}

/** WeChat channel: long-poll receive loop plus send/typing helpers. */
export class WeChatChannel {
  #token;
  #baseUrl;
  #storageDir;
  #log;
  #abort = new AbortController();
  #syncBuf = '';
  #typingTickets = new Map();
  #lastSendAt = new Map();

  constructor({ token, baseUrl, storageDir, log }) {
    this.#token = token;
    this.#baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.#storageDir = storageDir;
    this.#log = log;
    const file = join(storageDir, 'sync-buf.json');
    try {
      this.#syncBuf = JSON.parse(readFileSync(file, 'utf8')).get_updates_buf ?? '';
    } catch {
      this.#syncBuf = '';
    }
  }

  stop() {
    this.#abort.abort();
  }

  /**
   * Run the receive loop.
   * @param {(message: any) => void} onMessage
   */
  async run(onMessage) {
    let timeoutMs = DEFAULT_LONG_POLL_MS;
    let failures = 0;
    this.#log(this.#syncBuf ? `wechat: resuming from saved sync buffer` : 'wechat: starting fresh sync');
    while (!this.#abort.signal.aborted) {
      try {
        const response = await post(this.#baseUrl, 'ilink/bot/getupdates', { get_updates_buf: this.#syncBuf }, this.#token, timeoutMs);
        if (response.longpolling_timeout_ms > 0) timeoutMs = response.longpolling_timeout_ms;
        const failed = (response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0);
        if (failed) {
          if (response.errcode === SESSION_EXPIRED_ERRCODE || response.ret === SESSION_EXPIRED_ERRCODE) {
            this.#log('wechat: session expired; re-login required. Pausing 1 hour.');
            failures = 0;
            await this.#sleep(3_600_000);
            continue;
          }
          failures += 1;
          this.#log(`wechat: getupdates failed ret=${response.ret} errcode=${response.errcode} (${failures}/${MAX_CONSECUTIVE_FAILURES})`);
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            failures = 0;
            await this.#sleep(BACKOFF_MS);
          } else {
            await this.#sleep(RETRY_MS);
          }
          continue;
        }
        failures = 0;
        if (response.get_updates_buf) {
          this.#syncBuf = response.get_updates_buf;
          try {
            writeFileSync(join(this.#storageDir, 'sync-buf.json'), JSON.stringify({ get_updates_buf: this.#syncBuf }), 'utf8');
          } catch {
            /* best-effort */
          }
        }
        for (const message of response.msgs ?? []) onMessage(message);
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        failures += 1;
        this.#log(`wechat: getupdates error (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${String(error)}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await this.#sleep(BACKOFF_MS);
        } else {
          await this.#sleep(RETRY_MS);
        }
      }
    }
  }

  async #sleep(ms) {
    if (this.#abort.signal.aborted) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  /** Extract the first text body from an incoming message. */
  static textOf(message) {
    for (const item of message.item_list ?? []) {
      const text = item?.text_item?.text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
    return '';
  }

  /** Classify an incoming message for logging and file notices. */
  static kindOf(message) {
    const items = message.item_list ?? [];
    if (items.some((item) => item?.image_item)) return 'image';
    if (items.some((item) => item?.voice_item)) return 'voice';
    if (items.some((item) => item?.file_item)) return 'file';
    if (items.some((item) => item?.video_item)) return 'video';
    if (items.some((item) => item?.text_item)) return 'text';
    return 'empty';
  }

  static isDirectUserMessage(message) {
    return message.message_type === MessageType.USER && !message.group_id;
  }

  /**
   * Send a text reply, splitting long bodies.
   * @param {string} to - WeChat user id.
   * @param {string} text
   * @param {string} contextToken
   */
  async sendText(to, text, contextToken) {
    const segments = splitText(text, 1800);
    for (const [index, segment] of segments.entries()) {
      await this.#pace(to);
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: `wechat-dsh-${randomUUID()}`,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: segment } }],
        },
      };
      await post(this.#baseUrl, 'ilink/bot/sendmessage', body, this.#token);
      this.#log(`wechat: sent segment ${index + 1}/${segments.length} (${segment.length} chars)`);
    }
  }

  /** Send one typing indicator; failures are non-fatal. */
  async sendTyping(to, contextToken, status = TypingStatus.TYPING) {
    try {
      const ticket = await this.#typingTicket(to, contextToken);
      if (!ticket) return;
      await post(this.#baseUrl, 'ilink/bot/sendtyping', { ilink_user_id: to, typing_ticket: ticket, status }, this.#token, 10_000);
    } catch {
      /* typing is cosmetic */
    }
  }

  async #typingTicket(userId, contextToken) {
    const cached = this.#typingTickets.get(userId);
    if (cached && Date.now() - cached.at < 600_000) return cached.ticket;
    try {
      const response = await post(this.#baseUrl, 'ilink/bot/getconfig', { ilink_user_id: userId, context_token: contextToken }, this.#token, 10_000);
      if (!response.typing_ticket) return '';
      this.#typingTickets.set(userId, { ticket: response.typing_ticket, at: Date.now() });
      return response.typing_ticket;
    } catch {
      return '';
    }
  }

  /** Keep consecutive sends to one user ordered by receiver timestamp. */
  async #pace(userId) {
    const last = this.#lastSendAt.get(userId) ?? 0;
    const wait = last + 350 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#lastSendAt.set(userId, Date.now());
  }
}

/** Split text into segments, preferring newline and space boundaries. */
export function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf('\n', maxLen);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    segments.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/u, '');
  }
  return segments;
}

export { TypingStatus, DEFAULT_BASE_URL };
