/**
 * config.js — bridge configuration with defaults and file overlay.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DSH_WEB_URL = 'http://127.0.0.1:55787';

/**
 * Load the bridge configuration.
 *
 * Resolution order (later wins): built-in defaults, `config.json` beside this
 * package, then explicit environment overrides.
 * @param {{ rootDir: string }} options
 */
export function loadConfig({ rootDir }) {
  const file = join(rootDir, 'config.json');
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`wechat-dsh-bridge: invalid config.json: ${String(error)}`);
    }
  }

  const storageDir =
    process.env.WECHAT_DSH_STORAGE_DIR ||
    fromFile.storageDir ||
    join(homedir(), '.wechat-dsh-bridge');

  const config = {
    /** DSH Web GUI root, as printed by the running harness. */
    dshUrl: process.env.DSH_WEB_URL || fromFile.dshUrl || DEFAULT_DSH_WEB_URL,
    /** Optional DSH home override (defaults to $DSH_HOME or ~/.dsh). */
    dshHome: process.env.DSH_HOME || fromFile.dshHome || join(homedir(), '.dsh'),
    /** Directory holding the reused WeChat token.json and bridge state. */
    wechatStorageDir:
      process.env.WECHAT_ACP_STORAGE_DIR ||
      fromFile.wechatStorageDir ||
      join(homedir(), '.wechat-acp', 'instances', 'codex-main'),
    storageDir,
    logFile: process.env.WECHAT_DSH_LOG_FILE || fromFile.logFile || join(storageDir, 'bridge.log'),
    pidFile: process.env.WECHAT_DSH_PID_FILE || fromFile.pidFile || join(storageDir, 'bridge.pid'),

    /** Which DSH session the bridge drives. `last` follows the most recent. */
    targetSessionId: process.env.WECHAT_DSH_SESSION || fromFile.targetSessionId || 'last',
    /** Working directory used when the bridge must create a session. */
    workspaceCwd: fromFile.workspaceCwd || process.cwd(),

    /** Forward assistant prose from the GUI to WeChat. */
    syncAssistantToWeChat: fromFile.syncAssistantToWeChat ?? true,
    /** Do not echo a reply twice when WeChat itself prompted the turn. */
    suppressSelfEcho: fromFile.suppressSelfEcho ?? true,
    /** Include tool-call headlines in WeChat replies. */
    showToolCalls: fromFile.showToolCalls ?? true,
    /** Ask WeChat before DSH performs an approval-gated action. */
    forwardApprovals: fromFile.forwardApprovals ?? true,
    /** Seconds WeChat may take to answer an approval before it fails closed. */
    approvalTimeoutSec: fromFile.approvalTimeoutSec ?? 300,
    /** Forward ask_user_question prompts to WeChat. */
    forwardQuestions: fromFile.forwardQuestions ?? true,
    /** Only accept WeChat messages from these user ids; empty means anyone. */
    allowedUserIds: fromFile.allowedUserIds ?? [],
  };

  return config;
}
