# CLAUDE.md — 内部 fork 维护与部署

本仓库是 `tiann/hapi` 的私有 fork，**只做内部维护，不向上游提 PR**。
上游代码通过 merge 进入，内部改动通过分支进入，部署只认冻结的 `release/*`。
`AGENTS.md` 是上游文件，保持只读，不要把内部约定写进去。

## 远端

| remote | URL | 用途 |
|---|---|---|
| `origin` | `https://github.com/tiann/hapi.git` | 上游，只 fetch，不 push |
| `fork` | `git@github.com:goldenmilestech/hapi.git` | 内部，唯一推送目标 |

## 分支模型

```text
origin/main (tiann/hapi)
      │  git merge origin/main（上游发版后，在 main 上做一次）
      ▼
fork/main  ← feat/* fix/* 本地 merge 合入（不开 PR）
      │  git switch -c release/YYYYMMDD-N main
      ▼
release/YYYYMMDD-N   ← 切出即冻结，只接受热修 cherry-pick
      │  构建 + 上传
      ▼
VPS  →  tag: deploy-YYYYMMDD-N
```

| 分支 | 生命周期 | 规则 |
|---|---|---|
| `main` | 永久 | 唯一集成基线 = 上游最新 + 全部内部定制；只放已验收代码 |
| `feat/*` `fix/*` | ≤ 2 周 | 从 `main` 切；用 rebase 跟进 `main`；合回后删除 |
| `release/*` | 长期保留 | 从 `main` 切出后冻结；不开发新特性，只 cherry-pick 热修 |
| `hotfix/*` | 小时级 | 从当前 `release` 切；合回 `main` 并 cherry-pick 回 `release` |

## 常规操作

### 开新功能

```bash
git fetch fork
git switch -c feat/<slug> fork/main
# 开发、测试
```

分支存在超过两周时，先 `git rebase fork/main` 再继续，避免再次出现落后数百个提交的分支。

### 合入 main

```bash
git switch main
git merge --no-ff feat/<slug>
bun run typecheck && bun run test
git push fork main
git branch -d feat/<slug>
```

### 部署

每次部署从 `main` 新切一个 `release` 分支，不在旧 release 上继续提交。

```bash
git fetch fork
git switch -c release/2026-11-10 fork/main

# 完整构建（含 tunwg 下载 + web 构建 + 嵌入资源）
bun run build:single-exe
# 只重建 Linux 二进制（web 资源已生成时）
(cd cli && bun run build:exe:allinone --target bun-linux-x64-baseline --outdir dist-exe)

SHA=$(git rev-parse --short=8 HEAD)
# 产物：dist-exe/bun-linux-x64-baseline/hapi（约 160 MB，gzip 后约 80 MB）
gzip -c dist-exe/bun-linux-x64-baseline/hapi \
  | ssh root@124.220.24.3 "gunzip > /usr/local/bin/hapi.new"

ssh root@124.220.24.3 "
  set -e
  systemctl stop hapi-hub
  cp /usr/local/bin/hapi /usr/local/bin/hapi.bak-\$(date +%Y%m%d-%H%M)
  mv /usr/local/bin/hapi.new /usr/local/bin/hapi
  chmod +x /usr/local/bin/hapi
  echo '$SHA' > /etc/hapi/DEPLOYED_COMMIT
  systemctl start hapi-hub
  sleep 2
  systemctl is-active hapi-hub
  curl -sf http://172.30.0.1:3006/health
"

git tag deploy-2026-11-10-1 release/2026-11-10
git push fork --tags
```

部署后必须确认 `/health` 返回正常，并记录产物 SHA 与 tag 的对应关系。

### 热修

```bash
git switch -c hotfix/<slug> release/<current>
# 修复、验证
git switch release/<current> && git merge --no-ff hotfix/<slug>   # 重新构建部署
git switch main && git cherry-pick <sha>                          # 主线同步修复
```

### 上游同步

```bash
git fetch origin
git switch main
git merge origin/main
bun run typecheck && bun run test
git push fork main
```

冲突只在 `main` 上解决一次。`main` 不要 rebase：它是共享基线，且 `release/*` 从它切出，改写 SHA 会让线上 commit 失去对应关系。

## 部署环境

| 项 | 值 |
|---|---|
| hub 主机 | `124.220.24.3`（腾讯云 Debian 13） |
| 域名 | `hapi.goldenmilestech.com`（Traefik → `172.30.0.1:3006`） |
| 二进制 | `/usr/local/bin/hapi` |
| 服务 | systemd `hapi-hub.service`，参数 `hapi hub --no-relay` |
| 部署记录 | `/etc/hapi/DEPLOYED_COMMIT`（本次构建的 git SHA） |
| 备份 | `/usr/local/bin/hapi.bak-<时间戳>`，保留上一版即可 |
| 数据 | `/home/hapi/.hapi`（SQLite + token） |

排障顺序：`systemctl status hapi-hub` → `journalctl -u hapi-hub -n 100` → Traefik 路由 → DNS。

## 禁止事项

- 不向 `origin` 提 PR，不向 `origin` push。
- 不从 `feat/*` 或 `main` 直接部署；部署只认 `release/*` 的冻结提交。
- 不 rebase `main`，不 force-push `main` / `release/*` / 已上线的 tag。
- 不把未验收的代码合进 `main`；实验性功能留在 `feat/*`。
- 不在 `release/*` 上开发新特性。

## 内部定制清单

| 分支/提交 | 内容 | 主要改动面 |
|---|---|---|
| `feat/session-share-v034`（2026-11-11 已合入 `main`） | 会话分享链接（带作用域的临时 token；token 由 share id 推导，可在弹窗中再次查看/复制并续期，旧随机 token 记录可恢复） | hub 分享接口 + web 分享页 |
| `feat/auto-title-provider-v034`（2026-11-11 已合入 `main`） | hub 用首条用户消息自动生成会话标题 | `hub/src/sync/titleSuggestion.ts`、`syncEngine.ts`、`socket/handlers/cli/sessionHandlers.ts`、`startHub.ts` |
| `feat/btw-side-question-v034`（2026-11-11 已合入 `main`） | `/btw` 侧问题（不打断主会话） | cli + web |
| `main`（2026-11-11） | Missions 控制台：Manager/Worker 分组、审批收件箱、停止/归档操作、work-graph 时间线，以及 `work-graph-updated` SSE 实时刷新 | `web/src/routes/missions/`、`web/src/lib/missions.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/workGraph.ts`、`shared/src/schemas.ts` |
| `main`（2026-11-11） | 会话列表完成圆点：回合结束且未读时显示，打开行后立即清除 | `web/src/components/SessionList.tsx`、`SessionRowSummary.tsx`、`web/src/lib/locales/` |
| `fix/session-running-spinner`（2026-11-11 已合入 `main`） | 运行中会话在 presence 呼吸点之外恢复转圈动画（上游 0.34.4 移除了行内 spinner） | `web/src/components/SessionRowSummary.tsx` |
| `main`（2026-11-11） | 旧 runner 兼容：只有声明 `spawn-reserved-session-id` 能力的 runner 才预分配会话 id；旧 CLI 直接走创建流程，避免 “Runner reported unexpected session id” 误报和无法 adopt 的幽灵 stub | `shared/src/runnerCapabilities.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/sync/syncEngineSpawnPrealloc.test.ts` |
| `main`（2026-11-11，2026-11-12 改为默认开启） | 会话列表分组「收起到活跃」：有活跃会话的分组默认只显示活跃行与当前打开会话，展开后按批次恢复非活跃行，可再次收起 | `web/src/components/SessionList.tsx`、`web/src/lib/locales/` |
| `fix/session-fold-pinned`（2026-11-12 已合入 `main`） | 「收起到活跃」与预览折叠不再隐藏置顶会话；仅剩置顶行不活跃的分组不折叠、不显示折叠按钮 | `web/src/components/SessionList.tsx`、`web/src/components/SessionList.directory-action.test.tsx` |
| `main`（2026-11-11） | 旧 CLI（≤0.30.x）把首条 prompt 原样写进 `summary`，首条消息带图片时标题变成上传路径。Hub 丢弃这类上传路径标题、按首条用户文本回填 `promptTitle`，启动时修复已有会话，并允许 AI 标题重新生成 | `hub/src/sync/uploadPathTitle.ts`、`promptTitle.ts`、`sessionCache.ts`、`titleSuggestion.ts`、`automaticTitleSuggestion.ts`、`socket/handlers/cli/sessionHandlers.ts`、`syncEngine.ts` |
| `feat/slash-menu-skills`（2026-11-11 已合入 `main`） | Web `/` 菜单并入会话全部 skills（全局/工作区/插件），技能行以 `$name` 插入，`$` 菜单不变；覆盖所有 flavor | `web/src/hooks/queries/useSlashCommands.ts`、`useSkills.ts`、`web/src/hooks/useActiveSuggestions.ts` |
| `main`（2026-11-11） | 每会话 context 上限与自动压缩：上下文 popover 内可设置 100k–1M 上限；Claude 会话通过原生 `autoCompactWindow`（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`）自动压缩，其他支持压缩的 flavor 由 hub 在用量达到有效上限 90% 时自动投递 `/compact`（Cursor/Gemini 为 `/compress`）；popover 底部「压缩上下文」按钮直接发送压缩命令 | `shared/src/contextLimit.ts`、`shared/src/schemas.ts`、`hub/src/store/`、`hub/src/sync/contextUsage.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/sessions.ts`、`web/src/components/AssistantChat/StatusBar.tsx`、`cli/src/claude/utils/contextLimit.ts` |
| `main`（2026-11-11） | 会话列表右键「分叉会话」不再限 Codex：按 `capabilities.conversationHistory.forkCurrent` 开放给所有 flavor（Claude/Grok/Pi 等）；归档分叉仍只支持 Codex | `web/src/components/SessionList.tsx`、`web/src/components/SessionList.directory-action.test.tsx` |
| `main`（2026-11-11） | Claude 历史分叉：助手回答的 hover 操作栏可「分叉」，从该回答处截断原生 transcript 生成新会话（copy `~/.claude/projects/<cwd>/<session>.jsonl` 到边界 uuid 的祖先链并 resume）。assistant 消息用 Claude transcript uuid 作为 hub localId，hub 对其立即标记 invoked | `shared/src/conversationHistory.ts`、`cli/src/claude/historyFork.ts`、`cli/src/claude/runClaude.ts`、`cli/src/claude/utils/sdkToLogConverter.ts`、`cli/src/api/apiSession.ts`、`hub/src/store/messages.ts`、`hub/src/sync/forkTranscript.ts`、`hub/src/sync/syncEngine.ts`、`web/src/components/AssistantChat/messages/AssistantMessage.tsx`、`web/src/lib/assistant-runtime.ts` |
| `feat/multi-token-access`（2026-11-11） | 多 token 凭证：owner 在 Settings 签发绑定 namespace 的独立 token（token 由 hub secret 派生，可重复查看；库中只存 SHA-256）；每个 namespace 只允许一个有效 token，绑定后该 namespace 对 legacy 共享 token 关闭（含已签发的 legacy JWT）；JWT 带 `tid`，吊销立即生效并断开对应 CLI/terminal socket 与 SSE；legacy `base:namespace` 由 `HAPI_LEGACY_SHARED_TOKEN` 控制，默认保留 | `hub/src/store/accessTokens.ts`、`hub/src/config/accessTokenSecret.ts`、`hub/src/accessTokens/personalToken.ts`、`hub/src/utils/accessTokenResolver.ts`、`hub/src/web/routes/accessTokens.ts`、`hub/src/web/middleware/auth.ts`、`hub/src/socket/server.ts`、`hub/src/sse/sseManager.ts`、`shared/src/apiTypes.ts`、`web/src/routes/settings/tokens.tsx` |
| `feat/feishu-login`（2026-11-12） | 飞书网页登录：授权码 → hub 换 `open_id` → 首次登录自动分配 `fs_<hash(open_id)>` namespace，或按 owner 配置的邮箱绑定到已有 namespace；owner 由 `FEISHU_OWNER_OPEN_ID` / `FEISHU_OWNER_EMAIL` 映射到 `default`；登录响应返回个人 token（供 Web 持久会话和 CLI 使用）；设置页提供「我的访问令牌」和飞书邮箱绑定管理 | `hub/src/feishu/`、`hub/src/store/feishuBindings.ts`、`hub/src/accessTokens/personalToken.ts`、`hub/src/web/routes/{auth,feishu,meAccessToken}.ts`、`web/src/lib/feishuAuth.ts`、`web/src/hooks/useAuthSource.ts`、`web/src/components/LoginPrompt.tsx`、`web/src/routes/auth/feishu.tsx`、`web/src/routes/settings/tokens.tsx` |
| `feat/cli-update-command`（2026-11-12） | `hapi update`：从 fork 的 `cli-*` GitHub Release 读取最新版本，按平台下载单文件、校验 `checksums.txt`、备份并原子替换当前二进制，等待 runner mtime 自交接；`--check`、`--tag`、`--force`、`--bin`、`--keep`、`--no-wait`；runner 设置 `HAPI_AUTO_UPDATE=1` 时每 6 小时（失败 1 小时）后台检查一次，带抖动 | `cli/src/commands/update.ts`、`cli/src/update/`、`cli/src/commands/registry.ts`、`cli/src/commands/help.ts`、`cli/src/runner/run.ts` |
| `fix/resume-stale-runner-child`（2026-11-12） | 恢复会话自愈：runner 重启后 spawn 去重会把“进程存活但 hub 会话 socket 已死”的恢复子进程当作可复用结果返回，hub 等 active 超时后会话无法恢复；hub 现在在激活超时后先 `stopRunnerSession` 清理陈旧子进程并重试 spawn 一次（PTY/Pi 仍走各自的持久化 reconciliation），并发历史操作与归档分叉使用不同报错文案；runner 记录 spawn 去重命中与恢复子进程日志 | `hub/src/sync/syncEngine.ts`、`hub/src/sync/syncEngineResumeStaleRunnerChild.test.ts`、`cli/src/runner/run.ts` |
| `feat/session-outline-full`（2026-11-12） | 会话大纲始终展示整个会话的 prompt（不再受已加载消息窗口限制）：hub 新增 `/api/sessions/:id/outline` 会话级索引（仅含已投递用户消息，跳过 CLI 回显），web 将索引与已加载窗口合并、已加载条目优先；点击未加载条目按需加载目标上下文后跳转，点击时先关闭尾随吸附避免被 ResizeObserver 拉回底部 | `hub/src/store/messages.ts`、`hub/src/store/messageStore.ts`、`hub/src/sync/messageService.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/messages.ts`、`hub/src/web/middleware/auth.ts`、`shared/src/apiTypes.ts`、`web/src/api/client.ts`、`web/src/chat/outline.ts`、`web/src/components/SessionChat.tsx`、`web/src/components/AssistantChat/HappyThread.tsx` |
| `feat/open-workspace-in-vscode`（2026-11-12） | 会话头部 VS Code 按钮：runner 新增 `open-workspace` machine RPC（目录校验限制在工作区根内），hub 暴露 `POST /api/machines/:id/open-workspace`，web 按 runner 能力显示按钮，点击在会话所在机器用 VS Code 打开会话工作目录 | `shared/src/rpcMethods.ts`、`shared/src/runnerCapabilities.ts`、`shared/src/apiTypes.ts`、`cli/src/modules/common/openWorkspace.ts`、`cli/src/api/apiMachine.ts`、`hub/src/sync/rpcGateway.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/machines.ts`、`web/src/api/client.ts`、`web/src/components/SessionHeader.tsx`、`web/src/lib/locales/` |
| `feat/feishu-bot-send`（2026-11-13） | Claude 会话主动发飞书消息：私聊本人直接发送；私聊他人和群消息生成会话内审批卡，批准后由 hub 发送并回执；群消息自动带发送人并 `<at>` 发送人，发送人无法解析、不在群内或成员列表被截断时拒绝；收件人支持 open_id/邮箱/姓名，群支持 chat_id/群名；新增 `feishu_send_message` / `feishu_send_status` MCP 工具 | `hub/src/feishu/outbound/`、`hub/src/store/feishuProfiles.ts`、`hub/src/web/routes/{feishuSend,permissions}.ts`、`hub/src/startHub.ts`、`hub/src/web/server.ts`、`shared/src/apiTypes.ts`、`cli/src/modules/feishu/`、`cli/src/claude/utils/startHappyServer.ts`、`cli/src/codex/{happyMcpStdioBridge,utils/buildHapiMcpBridge}.ts`、`web/src/components/ToolCard/`、`web/src/lib/locales/` |
| `feat/feishu-bot-binding`（2026-11-13） | 飞书机器人会话绑定：Hub 暴露 `/api/feishu/events` 接收 `im.message.receive_v1`（签名校验、AES 解密、事件去重），飞书对话通过 `/bind <绑定码>` 与 Hapi 会话 1:1 绑定，`/unbind` 解绑；普通消息进入会话，每轮结束把最终回答发回飞书；设置页生成绑定码并管理绑定，会话列表显示飞书绑定标识 | `hub/src/feishu/bot/`、`hub/src/store/feishuBotBindings.ts`、`hub/src/web/routes/feishuBot.ts`、`hub/src/web/server.ts`、`hub/src/startHub.ts`、`hub/src/configuration.ts`、`shared/src/apiTypes.ts`、`shared/src/sessionSummary.ts`、`web/src/routes/settings/feishu.tsx`、`web/src/components/SessionRowSummary.tsx` |
| `feat/feishu-cards-picker`（2026-11-13） | 飞书回复改为卡片：每轮结束先发折叠的「思考过程/执行过程」卡片（thinking + 工具调用），再发 Markdown 回答卡片（顶部「会话来自：<会话标题>」），卡片失败回退文本；按存储回答 id 去重，过滤模型输出的 `<at>` 标签；设置页会话选择器改为可搜索、按项目分组、带运行状态与已绑定标记的列表 | `hub/src/feishu/bot/{cards,turnSummary,feishuApi,feishuBot}.ts`、`web/src/components/SessionPicker.tsx`、`web/src/lib/sessionPicker.ts`、`web/src/routes/settings/feishu.tsx`、`web/src/lib/locales/` |
| `feat/session-stats`（2026-11-13） | 会话状态栏统计：在上下文进度条后显示整会话的「N 轮 M 步 · tok/s」与「累积 tok · 缓存命中 %」；hub 新增 `GET /api/sessions/:id/stats`（按消息日志 epoch+最新 seq 缓存，复用用量看板口径），web 在运行中 5s 轮询、思考结束后刷新；窄屏降级为 tok/s + 缓存命中，DSH 会话因 ACP 无 token 用量只显示轮次 | `hub/src/sync/sessionStats.ts`、`hub/src/sync/userPromptRows.ts`、`hub/src/sync/usageService.ts`、`hub/src/sync/messageService.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/messages.ts`、`hub/src/web/middleware/auth.ts`、`shared/src/apiTypes.ts`、`web/src/api/client.ts`、`web/src/components/SessionChat.tsx`、`web/src/components/AssistantChat/StatusBar.tsx`、`web/src/lib/locales/` |

新增定制时在合并进 `main` 的同一个提交里更新此表，上游同步时按表逐项验证。

## 迁移记录

- 2026-11-11：三条 0.30.7 定制分支已按 session-share → auto-title → btw 的顺序 cherry-pick 到上游 0.34.4 基线并合入 `main`，旧的 0.30.7 分支仅作历史保留，不再合入。
- 2026-11-11：`main` 直接新增 Missions 控制台（含 `work-graph-updated` SSE）和会话列表完成圆点，见上表。
- 2026-11-11：上游 0.34.4 的会话行改版移除了行内 spinner，仅保留 presence 呼吸点；已在 `SessionRowSummary.tsx` 恢复转圈并与呼吸点并存。
- 2026-11-11：修复旧 runner（0.30.7）从 Web 创建会话时报 “Runner reported unexpected session id”、但会话实际已创建的问题：hub 改为按 runner 能力协商是否预分配会话 id，旧 runner 不再产生误报和无法 adopt 的幽灵 stub。
- auto-title 的注入点（`sessionHandlers.ts` 的 `socket.on('message')`）已随合入适配到 0.34.4；后续上游同步时仍需按定制清单做端到端验证。
- 2026-11-11：`sessions` 表新增 `context_limit`（schema v32），旧库启动时自动 ALTER；`contextLimit` 作为可选字段进入 Session 协议，旧客户端/旧 runner 不受影响。
- 2026-11-12：「收起到活跃」改为默认行为：有活跃会话的分组默认只渲染活跃行与当前打开会话，`expandedFromActiveGroups` 记录用户展开过的分组（空集合 = 全部默认收起）；展开时至少多显示一个预览批次，保证非活跃行在预览上限之后也能被展开看到。
- 2026-11-12：修复「恢复会话失败」（`resume_failed` / `Session failed to become active`）：CLI 与 hub 的会话 socket 断开且未重连后，runner 仍把该进程当作可用子进程并去重掉重试 spawn，导致会话永久无法恢复。hub 现在在激活超时后停止陈旧子进程并重试一次；同时区分并发历史操作与归档分叉的报错文案。已人工归档重开一个受影响会话验证。
