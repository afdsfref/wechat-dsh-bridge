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
| Echo suppression | match `user/message.source.rpcId` against bridge requestIds |
| Approval | forwarded `approval/request` waterfall on the `$events` Gateway stream, answered via `$events/result` |
| Questions | `userQuestions` session projection, answered via `userQuestions/answer` |

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
3. Current live session on this machine: `session-270fd25b-3e25-42ba-b793-1855a7fe60ea`.

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
