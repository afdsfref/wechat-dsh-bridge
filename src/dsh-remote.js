/**
 * dsh-remote.js 鈥?minimal client for the DeepSeekRuntime (DSH) Web Remote API.
 *
 * Auth: the Web GUI authenticates browser requests with a signed
 * `dsh-auth-<sha256(authority)>` cookie whose HMAC secret is the durable
 * `client-connection/browser-session` grant in `$DSH_HOME/.credentials.yaml`.
 * This module mints an equivalent cookie locally, so the bridge speaks to the
 * GUI with owner privileges 鈥?the same authority the browser has.
 *
 * Transports:
 *  - unary RPC: POST /api/<endpoint> with { type: 'client-request', rpcId, method, payload: { args } }
 *  - streams:   WS  /api/remote.mux, frames { type: 'open', streamId, endpoint, payload: { args } }
 */
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DAY_MS = 86_400_000;

function b64url(input) {
  return Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Read the browser-session HMAC secret from the DSH credentials file.
 * Written as a deliberately narrow scan of the YAML: we only need one scalar.
 * @param {string} dshHome - absolute DSH home directory.
 * @returns {Buffer} 32-byte signing secret.
 */
function readBrowserSessionSecret(dshHome) {
  const file = join(dshHome, '.credentials.yaml');
  const text = readFileSync(file, 'utf8');
  let inRecord = false;
  let recordIndent = -1;
  let encoded = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (/^\s*client-connection\/browser-session:\s*$/u.test(line)) {
      inRecord = true;
      recordIndent = indent;
      continue;
    }
    if (!inRecord) continue;
    if (indent <= recordIndent) {
      inRecord = false;
      continue;
    }
    const match = /^\s*secret:\s*(\S+)\s*$/u.exec(line);
    if (match) encoded = match[1];
  }
  if (!encoded) {
    throw new Error(`wechat-dsh-bridge: no client-connection/browser-session secret in ${file}`);
  }
  const secret = Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.byteLength !== 32) {
    throw new Error(`wechat-dsh-bridge: unexpected browser-session secret length ${secret.byteLength}`);
  }
  return secret;
}

/**
 * Build the authority-scoped authentication cookie for one loopback listener.
 * @param {Buffer} secret - signing secret.
 * @param {string} authority - exact `host:port` the GUI listens on.
 * @returns {string} `name=value` cookie pair.
 */
function mintCookie(secret, authority) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 30 * DAY_MS;
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }));
  const signature = createHmac('sha256', secret).update(body).digest();
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
  return `${name}=v1.${body}.${b64url(signature)}`;
}

/** One multiplexed Gateway WebSocket carrying logical Remote streams. */
class RemoteMux {
  #url;
  #headers;
  #log;
  #socket = null;
  #opening = null;
  #nextStreamId = 0;
  /** @type {Map<string, { onItem: Function, onEnd: Function, onError: Function, done: Deferred }>} */
  #streams = new Map();

  constructor(url, headers, log) {
    this.#url = url;
    this.#headers = headers;
    this.#log = log;
  }

  /** Open the socket if it is not already open. */
  async connect() {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#opening) return this.#opening;
    this.#opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url, { headers: this.#headers });
      socket.addEventListener('open', () => {
        this.#socket = socket;
        this.#opening = null;
        this.#log('dsh: gateway socket open');
        resolve(socket);
      }, { once: true });
      socket.addEventListener('error', (event) => {
        const error = new Error(`gateway socket error: ${event?.message ?? 'unknown'}`);
        this.#opening = null;
        reject(error);
      }, { once: true });
      socket.addEventListener('message', (event) => this.#onMessage(event));
      socket.addEventListener('close', (event) => {
        this.#log(`dsh: gateway socket closed (${event.code})`);
        if (this.#socket === socket) this.#socket = null;
        const failure = new Error(`gateway socket closed (${event.code})`);
        for (const [, stream] of this.#streams) stream.onError(failure);
        this.#streams.clear();
      });
    });
    return this.#opening;
  }

  #onMessage(event) {
    const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.#log('dsh: non-JSON gateway frame ignored');
      return;
    }
    const stream = this.#streams.get(frame.streamId);
    if (!stream) return;
    switch (frame.type) {
      case 'item':
        stream.onItem(frame.value);
        break;
      case 'end':
        this.#streams.delete(frame.streamId);
        stream.onEnd();
        break;
      case 'error':
        this.#streams.delete(frame.streamId);
        stream.onError(new Error(frame.message ?? 'Remote stream failed'));
        break;
      default:
        break;
    }
  }

  /**
   * Open one logical stream.
   * @param {string} endpoint - Remote stream endpoint name.
   * @param {object} args - the exact named argument object the endpoint declares.
   * @param {{ onItem: Function, onEnd?: Function, onError?: Function }} handlers
   * @returns {Promise<{ send: (value: unknown) => void, end: () => void, cancel: () => void }>}
   */
  async openStream(endpoint, args, handlers) {
    await this.connect();
    const streamId = `wechat-dsh-${++this.#nextStreamId}`;
    const record = {
      onItem: handlers.onItem,
      onEnd: handlers.onEnd ?? (() => {}),
      onError: handlers.onError ?? (() => {}),
    };
    this.#streams.set(streamId, record);
    this.#socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    return {
      send: (value) => {
        if (this.#socket?.readyState === WebSocket.OPEN) {
          this.#socket.send(JSON.stringify({ type: 'item', streamId, value }));
        }
      },
      end: () => {
        this.#streams.delete(streamId);
        if (this.#socket?.readyState === WebSocket.OPEN) {
          this.#socket.send(JSON.stringify({ type: 'end', streamId }));
        }
      },
      cancel: () => {
        this.#streams.delete(streamId);
        if (this.#socket?.readyState === WebSocket.OPEN) {
          this.#socket.send(JSON.stringify({ type: 'cancel', streamId }));
        }
      },
    };
  }

  close() {
    this.#streams.clear();
    try {
      this.#socket?.close();
    } catch {
      /* socket already closing */
    }
    this.#socket = null;
  }
}

/** The DSH Web Remote client: unary calls plus event and follow streams. */
export class DshRemote {
  #baseUrl;
  #authority;
  #cookie;
  #log;
  #mux;
  /** @type {string | null} client id from the $events ready frame. */
  clientId = null;

  /**
   * @param {{ dshHome?: string, baseUrl: string, log?: (message: string) => void }} options
   */
  constructor(options) {
    const dshHome = options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');
    this.#log = options.log ?? ((message) => console.log(message));
    this.#baseUrl = options.baseUrl.replace(/\/$/u, '');
    const url = new URL(this.#baseUrl);
    this.#authority = url.host;
    const secret = readBrowserSessionSecret(dshHome);
    this.#cookie = mintCookie(secret, this.#authority);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.#mux = new RemoteMux(`${wsProtocol}//${url.host}/api/remote.mux`, { host: this.#authority, cookie: this.#cookie }, this.#log);
  }

  /**
   * Invoke one unary Remote endpoint.
   * @param {string} endpoint - e.g. `session/prompt`.
   * @param {object} args - named argument object.
   * @returns {Promise<any>} the endpoint value.
   */
  async call(endpoint, args) {
    const rpcId = `wechat-dsh-${randomUUID()}`;
    const response = await fetch(`${this.#baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        host: this.#authority,
        cookie: this.#cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`dsh ${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`dsh ${endpoint}: non-JSON response ${text.slice(0, 200)}`);
    }
    const result = envelope.result;
    if (!result) throw new Error(`dsh ${endpoint}: malformed envelope`);
    if (!result.ok) {
      const error = result.error ?? {};
      const failure = new Error(`dsh ${endpoint}: ${error.code ?? 'error'} ${error.message ?? ''}`.trim());
      failure.code = error.code;
      failure.details = error.details;
      throw failure;
    }
    return result.value;
  }

  /**
   * Open one Remote stream.
   * @param {string} endpoint
   * @param {object} args - the exact named argument object the endpoint declares.
   * @param {{ onItem: Function, onEnd?: Function, onError?: Function }} handlers
   */
  async stream(endpoint, args, handlers) {
    return this.#mux.openStream(endpoint, args, handlers);
  }

  /**
   * Subscribe to forwarded Host events (the `$events` stream).
   *
   * `$events` is special: its payload must be an objectively empty `args`
   * object, unlike business streams that carry `{ request }`.
   * @param {{ onEvent: (event: string, frame: any) => void }} handlers
   */
  async subscribeEvents(handlers) {
    const stream = await this.#mux.openStream('$events', {}, {
      onItem: (value) => {
        if (value?.type === 'ready') {
          this.clientId = value.clientId;
          this.#log(`dsh: event stream ready (client ${this.clientId})`);
          return;
        }
        if (value?.type === 'emit' || value?.type === 'waterfall') {
          handlers.onEvent(value.event, value);
        }
      },
      onError: (error) => this.#log(`dsh: event stream failed: ${error.message}`),
    });
    return stream;
  }

  /**
   * Answer a forwarded waterfall event (used for `approval/request`).
   * @param {string} eventId - the waterfall frame's eventId.
   * @param {{ kind: 'result', value?: unknown } | { kind: 'next' }} outcome
   */
  async answerEvent(eventId, outcome) {
    if (!this.clientId) throw new Error('dsh: event stream is not ready');
    // The Host validates an exact-key payload; `payload.value` carries the envelope.
    const rpcId = `wechat-dsh-${randomUUID()}`;
    const response = await fetch(`${this.#baseUrl}/api/$events/result`, {
      method: 'POST',
      headers: {
        host: this.#authority,
        cookie: this.#cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: '$events/result',
        payload: { args: { clientId: this.clientId, eventId, outcome } },
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`dsh $events/result: HTTP ${response.status}`);
    const envelope = JSON.parse(text);
    if (!envelope.result?.ok) {
      throw new Error(`dsh $events/result: ${envelope.result?.error?.message ?? 'failed'}`);
    }
  }

  close() {
    this.#mux.close();
  }
}

export { readBrowserSessionSecret, mintCookie };

