# my-wiki 项目交接（给 DeepSeek Harness / 下一个 AI 开发会话）

> 生成时间：2026-08-16
> 工作目录：`C:\my-wiki`
> 目标：自建个人知识库 wiki，双入口：网页管理 + QQ 机器人（NapCat/OneBot11）

## 0. 一句话现状

项目是 **Node.js 零依赖单进程** 服务：

- 后端：`server/src/`，用 Node 内置 `node:http`、`node:sqlite`、`WebSocket`、`fetch`
- 前端：`web/` 原生 HTML/JS/CSS，由后端同端口托管
- 数据：`server/data/knowledge.db`（SQLite）+ `usage.json` + `backups/`
- 配置：`server/config.json`（含 DeepSeek key，gitignore）

本机环境：**Windows PowerShell，Node v26.4.0，npm 11.17.0，无 Python，无 Docker**。

## 1. 已实现功能（本地已跑通）

- 核心 CRUD / 搜索 / 日志 API
- 网页：仪表盘、类型页、详情、日志、备份、群组权限、成员权限、设置、使用帮助
- QQ 命令：`/帮助 /记 /查 /详情 /改 /删 /确认删 /提醒 /过期 /今天 /密码 /我是 /身份 /权限 /分类名 /清空`
- 自然语言 DeepSeek 工具调用：搜索/创建/修改/删除/登记身份/查提醒/分类改名
- 身份识别 + 私密权限：账号类默认私密，群里不可见，仅归属人私聊可查改删
- 农历生日换算（`lunar-javascript` 唯一 npm 依赖）
- 到期提醒调度，机器人离线不丢、上线补发
- 每次 AI 调用后私聊费用报告 + `/user/balance` 钱包余额
- 标签功能
- 备份：自动 + 网页 + 接口 + 脚本，SQLite `VACUUM INTO` 一致性快照
- Minecraft 模组 wiki：`scripts/import-mc-mod.mjs` 从 `C:\mc\xiuxian_addon` 导入；`kind` 子类型 + `guide` 玩家指南；玩法问题优先命中 guide
- 群组权限：按群限制可用类型；关闭/自由/前缀三种触发；群成员私聊权限；成员默认权限
- 成员权限：按 `QQ + 群 + 分类` 配置查/增/改/删；群内 `/权限` 查看
- 分类显示名可改：网页设置页或 `/分类名` 命令；存 `type_label_overrides` 表
- AI 变更确认码：自然语言增/改/删/改名统一两位确认码，回复确认码才执行

## 2. 关键数据表

`server/src/db.mjs` 里：

- `entries`：所有条目共用主表，`payload` JSON 存类型专属字段
- `identities`：QQ → 名字
- `group_configs`：群级权限（type_rules、member_private_chat、default_member_rules）
- `member_permissions`：成员级权限（qq_id + group_id + rules）
- `type_label_overrides`：分类显示名覆盖
- `attachments` / `event_log` / `entries_fts`：附件、日志、FTS 表（FTS 当前主要用于未来升级，中文检索走 LIKE）

## 3. 关键文件地图

| 文件 | 作用 |
|---|---|
| `server/src/main.mjs` | 入口：HTTP 服务、OneBot 连接、调度、私聊/群消息权限过滤 |
| `server/src/routes.mjs` | 所有 `/api/*` 路由 + 静态网页 |
| `server/src/chat.mjs` | 消息入口：确认码拦截 → 命令 → AI |
| `server/src/commands.mjs` | QQ 命令解析（零成本） |
| `server/src/ai.mjs` | DeepSeek 工具调用、费用统计、两位确认码 pendingOps |
| `server/src/entries.mjs` | 条目 CRUD/搜索/提醒/可见性 |
| `server/src/types.mjs` | 类型注册中心 + 显示名覆盖 |
| `server/src/groups.mjs` | 群组权限模型/触发匹配 |
| `server/src/permissions.mjs` | 成员权限模型 |
| `server/src/type_labels.mjs` | 分类名覆盖存取 |
| `server/src/backup.mjs` | 备份 |
| `server/src/bot/onebot.mjs` | OneBot11 WS 适配器 |
| `web/app.js` | 前端全部逻辑（原生 JS） |
| `scripts/import-mc-mod.mjs` | 从 `C:\mc\xiuxian_addon` 导入修仙 wiki |
| `scripts/store-manual.mjs` | 使用手册写入 `help` 类型 |
| `scripts/test-send.mjs` / `test-member.mjs` | 机器人调试 |

## 4. 配置和秘密

- `server/config.json`：运行配置，**含 DeepSeek API Key**，不要提交公共仓库
- 关键项：
  - `ai.enabled=true`、`model=deepseek-chat`、`maxRequestsPerDay=200`
  - `ai.costNotifyQQ=495538306`，费用报告私聊发这里
  - `notify.qqUserId=495538306`
  - `bot.allowedGroups` 旧白名单 `["1103784008"]`；但**已配置且启用（enabled=true）的群会绕过这个白名单**，未配置群仍受旧白名单限制；停用（enabled=false）的配置等同未配置，仍受白名单约束（2026-08-16 修复）
- 测试群：`1103784008`；用户 QQ：`495538306`（身份 SY，曾短暂是 FG）
- 实际配置过的群：`346049634`（MC游戏群，`minecraft_mod` 前缀 `wiki2`，其它关闭，成员私聊关闭）

## 5. 启动 / 重启 / 测试

启动：

```powershell
cd C:\my-wiki
node server/src/main.mjs
```

网页：`http://localhost:8000`

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

模拟 QQ 消息（不用真实 QQ）：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/chat `
  -ContentType 'application/json' `
  -Body (@{ text='/查 钥匙'; user_id='495538306'; message_type='private' } | ConvertTo-Json)
```

重启 8000 端口服务（本沙箱需要提权，真实环境直接用 node 即可）：

```powershell
$conn = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Seconds 1 }
$node = (Get-Command node).Source
Start-Process -FilePath $node -ArgumentList 'server/src/main.mjs' `
  -WorkingDirectory 'C:\my-wiki' -WindowStyle Hidden `
  -RedirectStandardOutput 'C:\my-wiki\server\data\wiki.out.log' `
  -RedirectStandardError 'C:\my-wiki\server\data\wiki.err.log'
```

常用脚本：

```powershell
node scripts/import-mc-mod.mjs            # 导入/更新修仙 Addon wiki
node scripts/reset-mc-mod.mjs xiuxian_addon  # 清空该 mod 导入条目
node scripts/store-manual.mjs             # 使用手册写进数据库（网页帮助/AI 检索共用）
node scripts/backup-now.mjs               # 手动备份
node scripts/test-member.mjs <群号> <QQ号> # 查 OneBot 群成员角色
```

## 6. 重要坑 / 约定

1. **Node 必须 >= 22.5**，因为用了 `node:sqlite`；本机是 Node 26。
2. 本沙箱里 `node` 必须从 `C:\my-wiki` 根目录启动，否则 SQLite 建库路径可能不对；真实手机环境无此限制。
3. DeepSeek 出网在本沙箱需要提权启动服务；真实环境正常联网。
4. 本机没有 Docker。
5. 微信暂不接入：Gewechat 已停止维护，先专注 QQ + 本地。
6. 密码目前明文存本地库，用户明确暂不加密。
7. `config.json` 和 `data/` 都不应提交公共仓库。
8. 改前端静态文件后无需重启服务，浏览器 `Ctrl+F5` 刷新即可；改后端必须重启 8000 服务。
9. NapCat 若重启，OneBot WS 会自动重连；核心服务不要频繁重启以免打断正在测试的 QQ 消息。
10. 两个数字确认码机制：AI 变更会生成 pendingOps，用户回复两位码在 `chat.mjs` 入口直接消费执行；`/确认删` 也可兜底。

## 7. 权限判断顺序（重要）

群消息处理顺序：

1. `group_configs` 是否开启该分类（groupPolicy allowedTypes）
2. 触发方式：关闭/自由/前缀
3. `member_permissions` 单成员规则；没有则用群 `defaultMemberRules`；再没有则默认全量
4. 私密条目额外的归属人/私聊可见性

所以：

- 群里关闭的分类，任何成员都不能用，成员权限无法覆盖开启
- 群里开启但成员默认权限没开的，按默认权限执行
- 群主在“成员私聊权限”里始终豁免；成员级 CRUD 权限目前没有自动群主豁免，未配置则按群默认（用户已确认保持此语义，群主不豁免）
- 管理操作（`/分类名` 改分类显示名、AI rename_type）仅管理员可用：`config.bot.adminQqIds`，为空时回退 `notify.qqUserId`（2026-08-16 修复）
- 删除确认必须回到发起删除时的同群/同场景（2026-08-16 修复）；权限体系审查与完整设计见 `权限管理设计方案.md`

## 8. 当前待办 / 建议下一步

- 迁移到手机服务器（Debian arm64），见 `部署交接_手机服务器.md`
- 附件/图片上传（表已留，功能未接）
- 账号密码加密（用户暂时不要）
- 前端升级 Vue（当前原生 JS）
- 更多机器人适配（未来）
- 如果要用 DeepSeek Harness 继续开发，建议让它先读本文件、`项目规划.md`、`使用手册.md`、`本地测试指南.md`

## 9. 给 DeepSeek Harness 的第一句话建议

> 继续开发 C:\my-wiki 这个个人知识库项目。请先读完 `项目交接_DeepSeekHarness.md`、`项目规划.md`、`本地测试指南.md`，保持现有 Node.js 零依赖架构，不要引入 Python 或 Docker。改后端后重启 8000 端口服务，改前端只需刷新浏览器。测试群 1103784008，用户 QQ 495538306，DeepSeek key 在 server/config.json。
