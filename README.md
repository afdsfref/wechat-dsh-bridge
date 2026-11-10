# wechat-dsh-bridge

把**微信私聊**接到**正在运行的 DeepSeek Harness（DSH）桌面会话**上，让手机和电脑
看到同一段对话。

## 为什么不能直接用 wechat-codex-bridge

`wechat-codex-bridge` 通过 ACP 拉起一个**子进程**（Codex CLI 或 DSH 的 ACP profile）。
子进程里的会话是**独立的**：微信看到一个对话，GUI 看到另一个对话，上下文不共享。

本项目换了一条路：不拉子进程，直接调用 **DSH Web GUI 的 Web Remote API**，
对 GUI 里**已经存在的那个会话**读写。所以：

| | wechat-codex-bridge | wechat-dsh-bridge |
|---|---|---|
| 后端 | 独立子进程 | 正在运行的 GUI 会话 |
| 与 GUI 共享上下文 | 否 | **是** |
| 需要重新扫码 | — | 否（复用 `wechat-acp` 的 token） |
| 双向同步 | 否 | **是** |

## 工作方式

```
微信私聊 ──> WeChat iLink 长轮询 ──> session/prompt ──> DSH 会话（电脑端可见）
                                              │
DSH 回合结束 ──> session/follow 事件流 ──> 微信回复（过滤掉微信自己发起的回合）
审批/提问  <── $events waterfall + userQuestions 投影 ──> 微信回填
```

鉴权不用登录：DSH 用 `$DSH_HOME/.credentials.yaml` 里
`client-connection/browser-session` 的签名密钥给浏览器发 cookie；本桥接读同一个密钥，
在本地签出等价的 `dsh-auth-*` cookie，从而以**所有者身份**调用 API。

## 快速开始

```powershell
# 1. 确认 DSH 桌面端在跑（GUI 里能看到 URL）
#    dsh web 的地址，默认 http://127.0.0.1:55787

# 2. 确认微信 token 还在（沿用 wechat-acp 的扫码结果）
Test-Path "$env:USERPROFILE\.wechat-acp\instances\codex-main\token.json"

# 3. 启动
C:\Users\Administrator\Documents\Codex\wechat-dsh-bridge\start-wechat-dsh.cmd
```

日志：`%USERPROFILE%\.wechat-dsh-bridge\stdout.log`。

## 配置

`config.json`（可用同名的环境变量覆盖）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `dshUrl` | `http://127.0.0.1:55787` | DSH Web GUI 地址 |
| `targetSessionId` | `"last"` | 接哪个会话。`"last"` = 最近活跃的；也可填 `session-xxx` 固定一个 |
| `syncAssistantToWeChat` | `true` | 电脑端助手回复是否推到微信 |
| `suppressSelfEcho` | `true` | 微信自己发起的回合不再回推（防重复） |
| `showToolCalls` | `true` | 推送时附上工具调用摘要 |
| `forwardApprovals` | `true` | 审批请求转发到微信 |
| `forwardQuestions` | `true` | `ask_user_question` 转发到微信 |
| `approvalTimeoutSec` | `300` | 微信超时未答则失败关闭（fail-closed） |
| `allowedUserIds` | `[]` | 只接受这些微信用户；空 = 不限制 |

环境变量：`DSH_WEB_URL`、`DSH_HOME`、`WECHAT_ACP_STORAGE_DIR`、
`WECHAT_DSH_STORAGE_DIR`、`WECHAT_DSH_SESSION`。

## 微信里的用法

- **普通文字** → 作为该会话的一轮 prompt。
- **审批** → 回 `1` 允许一次 / `2` 拒绝 / `3` 取消。
- 目前只支持文字；图片和文件请从电脑端发送。

## 审批的设计取舍

DSH 的 `approval/request` 是 waterfall 事件，浏览器在 `$events` 流上抢答。
本桥接**只在「微信发起的回合」进行中**才接管审批：

- 电脑端自己在跑的活（同会话里的工具调用）→ 不打扰微信，GUI 决定；
- 别的会话的审批 → 直接 `next` 放行给 GUI；
- 微信不可达（还没人给机器人发过消息）→ 立刻 `next`，不占坑。

这样避免"一条没送达的审批卡死后续所有审批"。

## 已知限制

- 依赖 GUI 进程：DSH 关掉后桥接无法工作（它不是独立后端）。
- 一次只处理一个交互：微信没有线程，第二个并发审批会被让给 GUI。
- 会话 id 变了要改 `targetSessionId`（或用 `"last"`）。
- 读的是 DSH 的私有 Web API（非公开稳定契约），DSH 升级后可能需要跟进。

## 目录

```
src/
  index.js         入口：装配、路由、生命周期
  dsh-remote.js    Web Remote 客户端：cookie 签名、一元 RPC、WS 多路复用
  session-sync.js  跟随会话、按回合聚合、识别微信来源（source.rpcId）
  interactions.js  审批与提问转发、微信回填
  wechat.js        iLink 长轮询收发、token 复用、分段发送
  config.js        配置加载
start-wechat-dsh.cmd   启动
watchdog.ps1           挂死自愈
```
