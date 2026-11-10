---
name: wechat-dsh-bridge
description: Start, retarget, verify, or troubleshoot the WeChat-to-DSH bridge so the user can chat with a live DeepSeek Harness desktop session from WeChat, sharing context both ways. Use when WeChat should reach the DSH conversation on screen rather than a separate Codex process.
---

# WeChat DSH Bridge

Bridge WeChat direct messages to a **live DSH desktop session**, so the phone and
the GUI share one conversation in both directions. This is not the Codex bridge:
that one (`wechat-codex-bridge`) spawns an isolated agent process. Use this skill
whenever the user wants WeChat to talk to *the session they are looking at*.

## Why this exists

The ACP-based bridge starts a subprocess, so WeChat gets its own private session
while the GUI keeps another. This bridge instead drives the **running DSH Web
GUI's Remote API** — no subprocess — against a session that already exists:

| | `wechat-codex-bridge` | `wechat-dsh-bridge` (this) |
|---|---|---|
| Backend | spawned agent process | the running GUI process |
| Shares GUI context | no | **yes, both directions** |
| WeChat login | own QR | reuses the `wechat-acp` token |
| Requires DSH running | no | **yes** |

## How it authenticates

DSH authenticates browser requests with a signed `dsh-auth-<sha256(authority)>`
cookie; its HMAC secret is the durable `client-connection/browser-session` grant
in `$DSH_HOME/.credentials.yaml`. The bridge reads that same secret and mints an
equivalent cookie locally, so it calls the API with **owner** privileges. There is
no login step and no token to refresh.

## Data paths

| Direction | Mechanism |
|---|---|
| WeChat → DSH | `session/prompt` with a bridge-minted `requestId` |
| DSH → WeChat | `session/follow` stream, coalesced per turn |
| Turn origin | match `user/message.source.rpcId` against bridge requestIds → `fromBridge` |
| Echo suppression | `fromBridge` **and** no tool calls **and** reply text ≈ last prompt |
| Approval | forwarded `approval/request` waterfall on the `$events` Gateway stream, answered via `$events/result` |
| Questions | `userQuestions` session projection, answered via `userQuestions/answer` |

### Echo suppression must not eat the reply

This is the single easiest way to build a bridge that looks healthy and silently
never replies. The `fromBridge` flag marks *whose turn it is*, not *what may be
sent back*. Treating it as "drop everything" makes WeChat→DSH work while DSH→WeChat
dies for exactly the turns the phone is waiting on.

The correct rule, implemented in `session-sync.js` + `index.js`:

```js
// index.js — onTurnSettled
if (fromBridge && config.suppressSelfEcho && tools.length === 0 && isEchoOfPrompt(text)) {
  return; // the only thing worth dropping: our own prompt bounced back verbatim
}
// every other case, including all assistant replies, is pushed to WeChat
```

`isEchoOfPrompt` normalises both sides (strip whitespace and punctuation, lower
case) and compares against the last prompt WeChat submitted. A real answer never
matches; a pure echo always does. Keep the `tools.length === 0` guard: a turn that
did work is never an echo, even if its final text is short.

Ordering trap: `user/message` and `turn/start` can arrive in either order on the
follow stream. `onEvent` must mark **both** slots — set `this.#turn.fromBridge`
when a turn is live, else stash `#pendingBridgeTurn` for the `turn/start` that
follows. Marking only one slot leaves `fromBridge` false and pushes the user's own
words back at them.

Transport details that bite when reimplementing:

- Unary RPC: `POST /api/<endpoint>` with
  `{ type: 'client-request', rpcId, method, payload: { args } }`.
- Streams: `WS /api/remote.mux`, frame `{ type: 'open', streamId, endpoint, payload: { args } }`.
- `$events` requires an **objectively empty** `args`; business streams
  (`session/follow`) require `args.request`. Mixing them yields
  `invalid Remote stream request`.
- `agentId` in the Remote surface **is** the session id.

## This Machine

```text
Bridge:      C:\Users\Administrator\Documents\Codex\wechat-dsh-bridge
State/logs:  C:\Users\Administrator\.wechat-dsh-bridge\  (stdout.log, bridge.pid)
Config:      <bridge>\config.json
Node:        C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
WeChat token C:\Users\Administrator\.wechat-acp\instances\codex-main\token.json
```

`config.json` keys: `dshUrl`, `targetSessionId` (`"last"` or a fixed
`session-xxx`), `syncAssistantToWeChat`, `suppressSelfEcho`, `showToolCalls`,
`forwardApprovals`, `forwardQuestions`, `approvalTimeoutSec`, `allowedUserIds`.

## Start

```powershell
Start-Process -FilePath "C:\Users\Administrator\Documents\Codex\wechat-dsh-bridge\start-wechat-dsh.cmd" -WindowStyle Hidden
```

Confirm success in `stdout.log`: `bridge ready; driving session-…` plus
`event stream ready`. `watchdog.ps1` restarts it when `bridge.pid` is dead.

## Retarget to another session

1. Get the id: `session/list` (`"last"` already follows the most recently
   updated session, which is usually what the user means).
2. Set `targetSessionId` in `config.json`, then restart the bridge.
3. Do **not** hardcode a session id here — it goes stale as soon as the user opens
   a new conversation, and a bridge pointed at an idle old session looks connected
   while the GUI on screen never receives anything. Resolve it at runtime:

```powershell
# session/list needs the same minted cookie as every other RPC
# POST /api/session/list  body: { type:'client-request', rpcId, method:'session/list',
#                                payload:{ args:{ _request:{} } } }
# then sort items by updatedAt desc and take items[0].sessionId
```

`args` must contain `_request`; omitting it fails with
`gateway/arguments-invalid: missing "_request"`. The result lands in
`result.value.items`, each with `sessionId`, `updatedAt`, `running`, and a
`projections.values.title`.

## Usage in WeChat

- Plain text becomes one prompt on the followed session.
- Approval replies: `1` allow once, `2` reject, `3` cancel.
- Text only; images and files must be sent from the desktop.

## Approval policy (deliberate)

The GUI is the primary answerer. The bridge relays an approval **only while a
WeChat-originated turn is running**, and sends `next` for everything else —
other sessions' approvals, and desktop work inside the same session — so the
phone is never spammed. If WeChat is unreachable (nobody has messaged the bot
yet), it answers `next` immediately instead of holding the interaction open,
which would otherwise deadlock every later approval.

Outcomes are a closed vocabulary: `allowed-once` | `rejected` | `cancelled` |
`unavailable`. Always fail closed on timeout.

## Troubleshooting

- `no reply target yet`: nobody has messaged the bot since start; approvals fall
  back to the GUI until the user sends one message.
- `no client-connection/browser-session secret`: DSH has not activated its Web
  connection; open the GUI once.
- `HTTP 401` or empty results: `dshUrl` port is wrong, or DSH restarted on a new
  port — read the printed `dsh web:` URL and update `config.json`.
- `session: resolution failed`: `targetSessionId` names a deleted session; use
  `"last"` or a current id.
- `invalid Remote stream request`: stream `args` envelope is wrong (see above).
- Bridge dead but GUI fine: check `stdout.log` before assuming the token expired
  — the WeChat token is the last thing to suspect, since it is reused, not minted.

### WeChat receives nothing, but the bridge log looks fine

Read the log for the turn, not just "is it running". A healthy-looking line such as
`turn came from WeChat; skipping echo (1007 chars)` **is the bug**: the reply was
built and then discarded before send. Confirm with the log order — prompt accepted,
then `skipping echo`, then no `sent segment`. See "Echo suppression must not eat
the reply" above.

If the log shows `pushing … reply` and then `wechat: send failed`, the problem is
the channel, not the logic: bot token, `contextToken` expiry, or the WeChat side.
A stale `contextToken` is refreshed by the user sending the bot one fresh message.

### Process / launch traps on this machine

- `Get-Process` and `Get-CimInstance` can fail to see the DSH process even while it
  is listening on `127.0.0.1:55787`. Trust `Get-NetTCPConnection -LocalPort 55787`
  for "is DSH alive", not process enumeration.
- If the bridge dies a few hundred ms after start with
  `EPERM: operation not permitted, open '…\bridge.pid'`, the file sandbox is
  blocking its state directory. Confined modes cannot write outside the session
  workspace; launch it with wider file access, or the process exits after having
  already opened both sockets — which mimics a healthy start.
- Never write `config.json` with PowerShell `Set-Content -Encoding utf8`: it emits a
  BOM, and the bridge then fails with `Unexpected token '锘'`. Write UTF-8 without
  BOM, or use the `write` tool.
- `Start-Process` returns immediately; a hidden `cmd` wrapper can exit before the
  node child is up. Verify by pid + a fresh `bridge ready; driving` log line, and
  allow several seconds before concluding it failed.

### Publishing the skill to GitHub

No `git` CLI is installed on this machine; `gh` is authenticated as `afdsfref`.
Push files with the Contents API instead of a working tree:

```powershell
# read current sha (needed to update an existing file)
gh api repos/afdsfref/wechat-dsh-bridge/contents/SKILL.md --jq .sha
# then PUT base64 content with that sha
```

Repo layout mirrors the bridge: `SKILL.md`, `README.md`, `config.json`,
`package.json`, `start-wechat-dsh.cmd`, `watchdog.ps1`, `src/*.js`, `agents/`.

## Fragility to state plainly

This reads DSH's **private** Web Remote API, not a published contract. A DSH
upgrade can break it. When it fails after an upgrade, re-derive the endpoint
shapes from the installed `app.asar` (`dsh/node_modules/@deepseek-ai/dsh-*`,
especially `dsh-api-gateway` frames and `dsh-api-session-controller` descriptors)
before changing code.

Note: on this machine the install directory sometimes fails to resolve by long
path inside a confined shell; the 8.3 short name
`C:\Users\Administrator\AppData\Local\Programs\DEEPSE~1` works when the long path
does not.
