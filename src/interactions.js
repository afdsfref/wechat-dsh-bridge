/**
 * interactions.js — forward DSH approvals and questions into WeChat and wait
 * for the human's answer.
 *
 * Two different DSH mechanisms are bridged:
 *
 *  - `approval/request` is a forwarded Cordis waterfall delivered on the
 *    `$events` Gateway stream. The answer must be one of the closed outcomes
 *    `allowed-once` | `rejected` | `cancelled` | `unavailable`, returned through
 *    the `$events/result` unary endpoint.
 *  - `ask_user_question` surfaces in the `userQuestions` session projection and
 *    is answered through the `userQuestions/answer` unary endpoint with a
 *    structured batch.
 */

const OUTCOME_BY_CHOICE = {
  '1': 'allowed-once',
  '2': 'rejected',
  '3': 'cancelled',
};

/** Render an approval request as a WeChat prompt. */
function describeApproval(request) {
  const tool = request?.toolName ?? request?.tool ?? 'tool';
  const reason = request?.displayReason ?? request?.reason ?? '';
  const lines = [`⚠️ 需要你的批准：${tool}`];
  if (reason) lines.push(String(reason));
  lines.push('', '回复 1 = 允许一次', '回复 2 = 拒绝', '回复 3 = 取消本次操作');
  return lines.join('\n');
}

/** Render an `ask_user_question` call as a WeChat prompt. */
function describeQuestions(call) {
  const lines = ['❓ 需要你回答：'];
  for (const [index, question] of (call.questions ?? []).entries()) {
    lines.push('');
    lines.push(`${index + 1}. ${question.question}`);
    if (question.detail) lines.push(String(question.detail).slice(0, 500));
    const options = question.options ?? [];
    if (options.length) {
      lines.push('可选：');
      for (const [i, option] of options.entries()) {
        lines.push(`  ${i + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`);
      }
    }
  }
  lines.push('');
  lines.push('直接回复选项编号或文字即可。');
  return lines.join('\n');
}

/**
 * Tracks one pending human interaction while it waits for a WeChat reply.
 *
 * Only one interaction is pending at a time: WeChat has no threading, so a
 * second overlapping prompt would be ambiguous. Later arrivals are refused,
 * which makes DSH fail closed rather than silently guessing.
 */
export class InteractionBroker {
  #log;
  #config;
  #notify;
  /** @type {{ kind: 'approval', eventId: string, timer: NodeJS.Timeout } | { kind: 'question', agentId: string, callId: string, prompt: any, timer: NodeJS.Timeout } | null} */
  #pending = null;

  /**
   * @param {object} options
   * @param {(message: string) => void} options.log
   * @param {{ forwardApprovals: boolean, forwardQuestions: boolean, approvalTimeoutSec: number }} options.config
   * @param {(text: string) => Promise<boolean>} options.notify - deliver a prompt to WeChat; resolves false when nobody can receive it.
   * @param {string} [options.sessionId] - the session this broker speaks for.
   */
  constructor(options) {
    this.#log = options.log;
    this.#config = options.config;
    this.#notify = options.notify;
    this.#sessionId = options.sessionId ?? null;
  }

  /** The session whose interactions this broker forwards. */
  #sessionId = null;

  /** Point the broker at a different session. */
  setSessionId(sessionId) {
    this.#sessionId = sessionId;
  }

  get hasPending() {
    return this.#pending !== null;
  }

  /** Which interaction is waiting for a WeChat reply, or null. */
  get pendingKind() {
    return this.#pending?.kind ?? null;
  }

  /**
   * Handle one forwarded `approval/request` waterfall frame.
   * @param {{ eventId: string, request: any }} frame
   * @param {(eventId: string, outcome: { kind: 'result', value?: unknown }) => Promise<void>} respond
   * @returns {Promise<boolean>} whether the request was accepted for forwarding.
   */
  async onApproval(frame, respond) {
    if (!this.#config.forwardApprovals) {
      this.#log('approval: forwarding disabled; answering next (unavailable)');
      await respond(frame.eventId, { kind: 'next' });
      return false;
    }
    // Only this bridge's session is forwarded: another session's approval must
    // fall through to the GUI answerer instead of blocking on WeChat.
    if (this.#sessionId && frame.agentId && frame.agentId !== this.#sessionId) {
      this.#log(`approval: for another session (${frame.agentId}); leaving it to the GUI`);
      await respond(frame.eventId, { kind: 'next' });
      return false;
    }
    if (this.#pending) {
      this.#log('approval: another interaction is pending; declining to guess');
      await respond(frame.eventId, { kind: 'next' });
      return false;
    }
    const timeoutMs = Math.max(30, this.#config.approvalTimeoutSec) * 1000;
    const timer = setTimeout(() => {
      this.#log('approval: timed out; failing closed');
      this.#pending = null;
      respond(frame.eventId, { kind: 'result', value: 'cancelled' }).catch(() => {});
    }, timeoutMs);
    this.#pending = { kind: 'approval', eventId: frame.eventId, timer, respond };
    const delivered = await this.#notify(describeApproval(frame.request));
    if (!delivered) {
      // Nobody can answer a prompt WeChat never received; release the slot so a
      // later approval is not refused, and let the GUI stand in.
      clearTimeout(timer);
      this.#pending = null;
      this.#log('approval: could not reach WeChat; leaving it to the GUI');
      await respond(frame.eventId, { kind: 'next' });
      return false;
    }
    return true;
  }

  /**
   * Handle a new open question call discovered in the session projection.
   * @param {{ agentId: string, callId: string, prompt: any }} question
   * @returns {Promise<boolean>}
   */
  async onQuestion(question) {
    if (!this.#config.forwardQuestions) return false;
    if (this.#pending) {
      this.#log('question: another interaction is pending; leaving it to the GUI');
      return false;
    }
    const timeoutMs = Math.max(30, this.#config.approvalTimeoutSec) * 1000;
    const timer = setTimeout(() => {
      this.#log('question: timed out; leaving it answerable in the GUI');
      this.#pending = null;
    }, timeoutMs);
    this.#pending = { kind: 'question', ...question, timer };
    const delivered = await this.#notify(describeQuestions(question.prompt));
    if (!delivered) {
      // Same rule as approvals: a prompt nobody received must not hold the slot,
      // or every later interaction would be refused and normal messages swallowed.
      clearTimeout(timer);
      this.#pending = null;
      this.#log('question: could not reach WeChat; leaving it to the GUI');
      return false;
    }
    return true;
  }

  /**
   * Consume a WeChat message as the answer to the pending interaction.
   *
   * Approval replies must be the message and nothing else: `1`, `2`, or `3`.
   * Anything longer is the user talking to the agent, so it falls through to a
   * normal prompt instead of being swallowed. The pending approval stays open
   * and will settle by its own timeout (fail closed) if the user never answers.
   *
   * @param {string} text
   * @param {(agentId: string, callId: string, answer: any) => Promise<boolean>} answerQuestion
   * @returns {Promise<boolean>} whether the message was consumed.
   */
  async consume(text, answerQuestion) {
    const pending = this.#pending;
    if (!pending) return false;
    const body = text.trim();

    if (pending.kind === 'approval') {
      const outcome = OUTCOME_BY_CHOICE[body];
      if (!outcome) {
        this.#log(`approval: "${body.slice(0, 40)}" is not 1/2/3; treating it as a normal message`);
        return false;
      }
      clearTimeout(pending.timer);
      this.#pending = null;
      await pending.respond(pending.eventId, { kind: 'result', value: outcome });
      await this.#notify(`已回复 DSH：${outcome}`);
      return true;
    }

    // Question: only a bare option number or an exact option label answers it.
    // Free text is a normal prompt, so the user is never trapped by a question.
    const prompt = pending.prompt;
    const questions = prompt?.questions ?? [];
    const single = questions.length === 1 ? questions[0] : null;
    if (single) {
      const options = single.options ?? [];
      const byIndex = /^\d+$/u.test(body) ? options[Number(body) - 1] : undefined;
      const byLabel = options.find((option) => option.label === body);
      const chosen = byIndex ?? byLabel;
      if (!chosen) {
        this.#log(`question: "${body.slice(0, 40)}" matches no option; treating it as a normal message`);
        return false;
      }
      clearTimeout(pending.timer);
      this.#pending = null;
      const answers = questions.map((question) => ({ id: question.id, selected: [chosen.label] }));
      const accepted = await answerQuestion(pending.agentId, pending.callId, { answers });
      await this.#notify(accepted ? '已把你的回答发给 DSH。' : 'DSH 已不再接受该回答（可能已在界面里答过）。');
      return true;
    }

    // Multi-question calls need structured answers; free text cannot express
    // one answer per question, so keep it out of the interaction path.
    this.#log('question: multi-question call; free text becomes a normal message');
    return false;
  }

  /** Drop any pending interaction without answering it. */
  cancelPending() {
    if (!this.#pending) return;
    clearTimeout(this.#pending.timer);
    this.#pending = null;
  }
}

export { describeApproval, describeQuestions, OUTCOME_BY_CHOICE };
