# CLAUDE.md — 内部 fork 维护与部署

本仓库是 `tiann/hapi` 的私有 fork，**只做内部维护，不向上游提 PR**。
上游代码通过 merge 进入，内部改动通过分支进入，部署只认冻结的 `release/*`。
`AGENTS.md` 是上游文件，保持只读，不要把内部约定写进去。

## 远端

| remote | URL | 用途 |
|---|---|---|
| `origin` | `https://github.com/tiann/hapi.git` | 上游，只 fetch，不 push |
| `fork` | `git@github.com:qlqj-frederick-dong/hapi.git` | 内部，唯一推送目标 |

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
| `feat/session-share-v034`（2026-11-11 已合入 `main`） | 会话分享链接（带作用域的临时 token） | hub 分享接口 + web 分享页 |
| `feat/auto-title-provider-v034`（2026-11-11 已合入 `main`） | hub 用首条用户消息自动生成会话标题 | `hub/src/sync/titleSuggestion.ts`、`syncEngine.ts`、`socket/handlers/cli/sessionHandlers.ts`、`startHub.ts` |
| `feat/btw-side-question-v034`（2026-11-11 已合入 `main`） | `/btw` 侧问题（不打断主会话） | cli + web |
| `main`（2026-11-11） | Missions 控制台：Manager/Worker 分组、审批收件箱、停止/归档操作、work-graph 时间线，以及 `work-graph-updated` SSE 实时刷新 | `web/src/routes/missions/`、`web/src/lib/missions.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/workGraph.ts`、`shared/src/schemas.ts` |
| `main`（2026-11-11） | 会话列表完成圆点：回合结束且未读时显示，打开行后立即清除 | `web/src/components/SessionList.tsx`、`SessionRowSummary.tsx`、`web/src/lib/locales/` |
| `fix/session-running-spinner`（2026-11-11 已合入 `main`） | 运行中会话在 presence 呼吸点之外恢复转圈动画（上游 0.34.4 移除了行内 spinner） | `web/src/components/SessionRowSummary.tsx` |
| `main`（2026-11-11） | 旧 runner 兼容：只有声明 `spawn-reserved-session-id` 能力的 runner 才预分配会话 id；旧 CLI 直接走创建流程，避免 “Runner reported unexpected session id” 误报和无法 adopt 的幽灵 stub | `shared/src/runnerCapabilities.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/sync/syncEngineSpawnPrealloc.test.ts` |
| `main`（2026-11-11） | 会话列表分组支持「收起到活跃」：隐藏非活跃/已归档行，仅保留活跃会话与当前打开会话，展开后恢复原预览批次 | `web/src/components/SessionList.tsx`、`web/src/lib/locales/` |
| `main`（2026-11-11） | 旧 CLI（≤0.30.x）把首条 prompt 原样写进 `summary`，首条消息带图片时标题变成上传路径。Hub 丢弃这类上传路径标题、按首条用户文本回填 `promptTitle`，启动时修复已有会话，并允许 AI 标题重新生成 | `hub/src/sync/uploadPathTitle.ts`、`promptTitle.ts`、`sessionCache.ts`、`titleSuggestion.ts`、`automaticTitleSuggestion.ts`、`socket/handlers/cli/sessionHandlers.ts`、`syncEngine.ts` |

新增定制时在合并进 `main` 的同一个提交里更新此表，上游同步时按表逐项验证。

## 迁移记录

- 2026-11-11：三条 0.30.7 定制分支已按 session-share → auto-title → btw 的顺序 cherry-pick 到上游 0.34.4 基线并合入 `main`，旧的 0.30.7 分支仅作历史保留，不再合入。
- 2026-11-11：`main` 直接新增 Missions 控制台（含 `work-graph-updated` SSE）和会话列表完成圆点，见上表。
- 2026-11-11：上游 0.34.4 的会话行改版移除了行内 spinner，仅保留 presence 呼吸点；已在 `SessionRowSummary.tsx` 恢复转圈并与呼吸点并存。
- 2026-11-11：修复旧 runner（0.30.7）从 Web 创建会话时报 “Runner reported unexpected session id”、但会话实际已创建的问题：hub 改为按 runner 能力协商是否预分配会话 id，旧 runner 不再产生误报和无法 adopt 的幽灵 stub。
- auto-title 的注入点（`sessionHandlers.ts` 的 `socket.on('message')`）已随合入适配到 0.34.4；后续上游同步时仍需按定制清单做端到端验证。
