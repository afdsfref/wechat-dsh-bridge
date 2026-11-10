/**
 * session-sync.js — follow one DSH session and turn its durable events into
 * short, WeChat-suitable messages.
 *
 * The bridge needs to know whether a turn came from WeChat (so it does not echo
 * its own prompt back as a "remote" reply). DSH records that identity durably:
 * a prompt submitted through `session/prompt` lands as a `user/message` whose
 * `source.rpcId` is the requestId the caller minted. We remember our own
 * requestIds and match them against the turn's user message.
 */
import { readFileSync } from 'node:fs';

/** Concatenate the text blocks of an assistant message. */
function textOfBlocks(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/** Render one tool call as a single readable line. */
function describeToolCall(name, args) {
  let summary = '';
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    summary =
      parsed?.description ??
      parsed?.command ??
      parsed?.path ??
      parsed?.file_path ??
      parsed?.url ??
      parsed?.pattern ??
      parsed?.query ??
      '';
  } catch {
    /* keep the bare tool name */
  }
  if (Array.isArray(summary)) summary = summary.join(' ');
  if (summary && typeof summary === 'object') summary = JSON.stringify(summary);
  const trimmed = String(summary ?? '').replace(/\s+/gu, ' ').trim();
  const clipped = trimmed.length > 110 ? `${trimmed.slice(0, 107)}…` : trimmed;
  return clipped ? `${name}: ${clipped}` : String(name ?? 'tool');
}

/**
 * Follow a session, coalescing each turn into one reply.
 *
 * Emits nothing itself: the caller decides what to do with a settled turn.
 */
export class SessionSync {
  #remote;
  #log;
  #config;
  #onTurnSettled;
  #stream = null;
  #sessionId;
  #lastSeq = 0;
  #turn = null;
  /** requestIds minted by this bridge; matching turns are not echoed. */
  #ownRequests = new Set();
  #stopped = false;

  /**
   * @param {object} options
   * @param {import('./dsh-remote.js').DshRemote} options.remote
   * @param {string} options.sessionId
   * @param {(message: string) => void} options.log
   * @param {{ showToolCalls: boolean }} options.config
   * @param {(reply: { text: string, tools: string[], fromBridge: boolean, turn: number }) => Promise<void>} options.onTurnSettled
   */
  constructor(options) {
    this.#remote = options.remote;
    this.#sessionId = options.sessionId;
    this.#log = options.log;
    this.#config = options.config;
    this.#onTurnSettled = options.onTurnSettled;
  }

  get sessionId() {
    return this.#sessionId;
  }

  /** Whether a turn is currently running and originated from WeChat. */
  get bridgeTurnActive() {
    return this.#turn !== null && this.#turn.fromBridge;
  }

  /** Record a requestId this bridge submitted, so its turn is not echoed. */
  registerOwnRequest(requestId) {
    this.#ownRequests.add(requestId);
    if (this.#ownRequests.size > 200) {
      const [oldest] = this.#ownRequests;
      this.#ownRequests.delete(oldest);
    }
  }

  /** Point the follower at a different session, preserving process state. */
  async retarget(sessionId) {
    if (sessionId === this.#sessionId) return;
    this.stop();
    this.#sessionId = sessionId;
    this.#lastSeq = 0;
    this.#turn = null;
    await this.start();
  }

  /** Seed `lastSeq` from a history page so a restart does not replay old turns. */
  async primeFromHistory() {
    try {
      const page = await this.#remote.call('session/events', {
        request: {
          address: { kind: 'session', sessionId: this.#sessionId },
          maxMessages: 2,
          turnWindow: { minMessages: 1, minTurns: 1 },
        },
      });
      const records = page?.records ?? [];
      const last = records.at(-1)?.event?.seq;
      if (typeof last === 'number') this.#lastSeq = last;
      this.#log(`sync: primed at seq ${this.#lastSeq} for ${this.#sessionId}`);
    } catch (error) {
      this.#log(`sync: prime failed (${String(error).slice(0, 120)}); starting from stream head`);
    }
  }

  /** Open the follow stream. */
  async start() {
    this.#stopped = false;
    const stream = await this.#remote.stream(
      'session/follow',
      {
        request: {
          address: { kind: 'session', sessionId: this.#sessionId },
          turnWindow: { minMessages: 3, minTurns: 1 },
        },
      },
      {
        onItem: (value) => this.#onFrame(value),
        onEnd: () => this.#log('sync: follow stream ended'),
        onError: (error) => {
          if (this.#stopped) return;
          this.#log(`sync: follow stream failed: ${error.message}`);
        },
      },
    );
    this.#stream = stream;
    this.#log(`sync: following ${this.#sessionId}`);
  }

  stop() {
    this.#stopped = true;
    this.#stream?.cancel();
    this.#stream = null;
  }

  #onFrame(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'snapshot') {
      const asOf = value.projections?.asOfSeq;
      if (typeof asOf === 'number' && asOf > this.#lastSeq) this.#lastSeq = asOf;
      this.#log(`sync: baseline asOfSeq=${asOf ?? '?'}`);
      return;
    }
    if (value.type !== 'event') return;
    const event = value.event;
    if (!event || typeof event.seq !== 'number') return;
    if (event.seq <= this.#lastSeq) return;
    this.#lastSeq = event.seq;
    this.#onEvent(event).catch((error) => this.#log(`sync: event handling failed: ${String(error)}`));
  }

  async #onEvent(event) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'user/message': {
        const rpcId = data?.source?.rpcId;
        if (rpcId && this.#ownRequests.has(rpcId)) {
          if (this.#turn) this.#turn.fromBridge = true;
          else this.#pendingBridgeTurn = true;
        }
        return;
      }
      case 'turn/start': {
        this.#turn = {
          turn: data.turn ?? 0,
          text: '',
          tools: [],
          fromBridge: this.#pendingBridgeTurn === true,
        };
        this.#pendingBridgeTurn = false;
        return;
      }
      case 'assistant/message': {
        if (!this.#turn) return;
        const text = textOfBlocks(data.message?.content);
        if (text) this.#turn.text += text;
        return;
      }
      case 'tool/call': {
        if (!this.#turn || !this.#config.showToolCalls) return;
        this.#turn.tools.push(describeToolCall(data.name, data.arguments));
        return;
      }
      case 'turn/end': {
        const turn = this.#turn;
        this.#turn = null;
        this.#pendingBridgeTurn = false;
        if (!turn) return;
        const text = turn.text.trim();
        if (!text) return;
        await this.#onTurnSettled({ ...turn, text });
        return;
      }
      default:
        return;
    }
  }

  /** A user message arrived before `turn/start` for a bridge-minted prompt. */
  #pendingBridgeTurn = false;
}

/** Read a JSON file, returning `undefined` when absent or malformed. */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export { describeToolCall, textOfBlocks };
