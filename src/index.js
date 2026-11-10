/**
 * index.js — wechat-dsh-bridge entry point.
 *
 * Bridges WeChat direct messages to a *live* DeepSeekRuntime session, so the
 * phone and the desktop GUI share one conversation:
 *
 *   WeChat text  -> session/prompt on the target session
 *   DSH turn end -> assistant reply pushed back to WeChat
 *   approval/request + ask_user_question -> forwarded to WeChat, answer returned
 */
import { appendFileSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { loadConfig } from './config.js';
import { DshRemote } from './dsh-remote.js';
import { WeChatChannel, BridgeState, loadToken, TypingStatus } from './wechat.js';
import { SessionSync } from './session-sync.js';
import { InteractionBroker } from './interactions.js';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Resolve the session the bridge should drive.
 *
 * `last` follows the most recently updated session, which is what "the session
 * I am looking at in the GUI" means in practice. An explicit id pins one.
 */
async function resolveSessionId(remote, config, log) {
  if (config.targetSessionId && config.targetSessionId !== 'last') return config.targetSessionId;
  try {
    const value = await remote.call('session/list', { _request: {} });
    const items = value?.items ?? [];
    if (!items.length) {
      log('session: no existing session; creating one');
      const created = await remote.call('session/create', { request: { cwd: config.workspaceCwd } });
      return created.sessionId;
    }
    const newest = items.reduce((best, row) => (row.updatedAt > best.updatedAt ? row : best), items[0]);
    log(`session: following newest session ${newest.sessionId} (${newest.projections?.values?.title ?? 'untitled'})`);
    return newest.sessionId;
  } catch (error) {
    log(`session: resolution failed (${String(error).slice(0, 200)}); creating a new session`);
    const created = await remote.call('session/create', { request: { cwd: config.workspaceCwd } });
    return created.sessionId;
  }
}

/** Read the open question calls from a session's projections. */
async function readOpenQuestions(remote, sessionId) {
  try {
    const value = await remote.call('session/projections', { request: { sessionId } });
    const active = value?.values?.userQuestions?.active ?? [];
    return active;
  } catch {
    return [];
  }
}

async function main() {
  const config = loadConfig({ rootDir });
  mkdirSync(config.storageDir, { recursive: true });

  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    try {
      appendFileSync(config.logFile, `${line}\n`, 'utf8');
    } catch {
      /* logging is best-effort */
    }
  };

  log('wechat-dsh-bridge starting');
  log(`dsh: ${config.dshUrl}`);

  const token = loadToken(config.wechatStorageDir);
  if (!token) {
    log(`wechat: no token.json under ${config.wechatStorageDir}; run the wechat-acp linker once`);
    process.exitCode = 2;
    return;
  }
  log(`wechat: reusing bot token for ${token.accountId}`);

  const remote = new DshRemote({ dshHome: config.dshHome, baseUrl: config.dshUrl, log });
  const state = new BridgeState(config.storageDir);
  const channel = new WeChatChannel({
    token: token.token,
    baseUrl: token.baseUrl,
    storageDir: config.storageDir,
    log,
  });

  const sessionId = await resolveSessionId(remote, config, log);

  /** Resolve where WeChat replies go: the most recent user who spoke to us. */
  const replyTarget = () => {
    const userId = state.lastActiveUserId;
    if (!userId) return null;
    const contextToken = state.user(userId)?.contextToken;
    if (!contextToken) return null;
    return { userId, contextToken };
  };

  const sendToWeChat = async (text) => {
    const target = replyTarget();
    if (!target) {
      log(`wechat: no reply target yet; dropping message: ${text.slice(0, 80)}`);
      return false;
    }
    try {
      await channel.sendText(target.userId, text, target.contextToken);
      return true;
    } catch (error) {
      log(`wechat: send failed: ${String(error).slice(0, 200)}`);
      return false;
    }
  };

  const broker = new InteractionBroker({
    log,
    config,
    sessionId,
    notify: (text) => sendToWeChat(text),
  });

  const sync = new SessionSync({
    remote,
    sessionId,
    log,
    config,
    onTurnSettled: async ({ text, tools, fromBridge }) => {
      if (fromBridge && config.suppressSelfEcho) {
        log(`sync: turn came from WeChat; skipping echo (${text.length} chars)`);
        return;
      }
      if (!config.syncAssistantToWeChat) {
        log('sync: assistant sync disabled; GUI-only reply');
        return;
      }
      const parts = [];
      if (config.showToolCalls && tools.length) {
        const shown = tools.slice(0, 8).map((line) => `· ${line}`);
        if (tools.length > shown.length) shown.push(`· …共 ${tools.length} 次工具调用`);
        parts.push(shown.join('\n'));
      }
      parts.push(text);
      const body = `🖥️ DSH（电脑端）\n\n${parts.join('\n\n')}`;
      log(`sync: pushing GUI turn to WeChat (${text.length} chars)`);
      await sendToWeChat(body);
    },
  });

  await sync.primeFromHistory();
  await sync.start();

  // Forward events let us answer approvals the way the browser does.
  let eventsStream = null;
  try {
    eventsStream = await remote.subscribeEvents({
      onEvent: (event, frame) => {
        if (event !== 'approval/request') return;
        // The GUI is the primary answerer. Only relay approvals that belong to
        // a WeChat-originated turn; everything else — desktop work running in
        // the same session, or another session entirely — stays in the GUI.
        if (!sync.bridgeTurnActive) {
          log('approval: not from a WeChat turn; leaving it to the GUI');
          return;
        }
        log(`approval: request for ${frame.request?.toolName ?? 'tool'}`);
        broker
          .onApproval(frame, (eventId, outcome) => remote.answerEvent(eventId, outcome))
          .catch((error) => log(`approval: forwarding failed: ${String(error).slice(0, 200)}`));
      },
    });
  } catch (error) {
    log(`approval: event stream unavailable (${String(error).slice(0, 160)}); approvals will use DSH defaults`);
  }

  // Questions are discovered through the session projection, which the GUI also
  // uses; a light poll keeps the bridge independent of extra stream plumbing.
  let seenQuestionCalls = new Set();
  const questionTimer = setInterval(async () => {
    if (!config.forwardQuestions) return;
    const active = await readOpenQuestions(remote, sync.sessionId);
    const current = new Set(active.map((call) => call.callId));
    for (const call of active) {
      if (seenQuestionCalls.has(call.callId) || call.state !== 'open') continue;
      seenQuestionCalls.add(call.callId);
      const agentId = sync.sessionId;
      await broker.onQuestion({ agentId, callId: call.callId, prompt: call });
    }
    for (const callId of seenQuestionCalls) {
      if (!current.has(callId)) seenQuestionCalls.delete(callId);
    }
  }, 5_000);

  const answerQuestion = async (agentId, callId, answer) => {
    try {
      return await remote.call('userQuestions/answer', { agentId, callId, answer });
    } catch (error) {
      log(`question: answer failed: ${String(error).slice(0, 200)}`);
      return false;
    }
  };

  /** Submit one WeChat message as a prompt on the followed session. */
  const submitPrompt = async (text, userId) => {
    const requestId = `wechat-${randomUUID()}`;
    sync.registerOwnRequest(requestId);
    await remote.call('session/prompt', {
      request: {
        requestId,
        sessionId: sync.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      },
    });
    log(`prompt: accepted from ${userId} (${text.length} chars)`);
  };

  channel.run(async (message) => {
    try {
      if (!WeChatChannel.isDirectUserMessage(message)) return;
      const userId = message.from_user_id;
      if (!userId) return;
      if (config.allowedUserIds.length && !config.allowedUserIds.includes(userId)) {
        log(`wechat: ignoring message from unauthorized user ${userId}`);
        return;
      }
      if (message.context_token) state.rememberUser(userId, message.context_token);

      const text = WeChatChannel.textOf(message);
      const kind = WeChatChannel.kindOf(message);
      log(`wechat: ${kind} from ${userId}: ${text ? text.slice(0, 120) : '(no text)'}`);

      if (kind !== 'text' || !text) {
        await sendToWeChat('目前只支持文字消息；图片/文件请先在电脑端发送。');
        return;
      }

      // A pending approval/question only claims a bare `1`/`2`/`3` (or an exact
      // option label). Anything else is the user talking to the agent, so it
      // must reach the session — never be swallowed as a bad approval reply.
      if (broker.hasPending) {
        const consumed = await broker.consume(text, answerQuestion);
        if (consumed) {
          log(`wechat: message consumed as interaction reply (pending=${broker.pendingKind})`);
          return;
        }
      }

      await channel.sendTyping(userId, message.context_token, TypingStatus.TYPING);
      await submitPrompt(text, userId);
      log(`wechat: submitted to session ${sync.sessionId}`);
    } catch (error) {
      log(`wechat: message handling failed: ${String(error).slice(0, 300)}`);
      await sendToWeChat(`桥接出错：${String(error).slice(0, 200)}`);
    }
  }).catch((error) => log(`wechat: monitor stopped: ${String(error).slice(0, 200)}`));

  // Persist the pid so the watcher can tell whether the bridge is alive.
  writeFileSync(config.pidFile, String(process.pid), 'utf8');

  const shutdown = async (signal) => {
    log(`shutting down (${signal})`);
    clearInterval(questionTimer);
    broker.cancelPending();
    sync.stop();
    try {
      eventsStream?.cancel();
    } catch {
      /* already closed */
    }
    channel.stop();
    remote.close();
    try {
      if (existsSync(config.pidFile) && readFileSync(config.pidFile, 'utf8').trim() === String(process.pid)) {
        unlinkSync(config.pidFile);
      }
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log(`bridge ready; driving ${sync.sessionId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export { resolveSessionId, readOpenQuestions };
