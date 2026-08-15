# NapCat 工作交接文档

> 给新会话快速上手：NapCat 是什么、怎么开发插件、本工作区已有哪些东西、有哪些坑。
> 适用范围：本机（Windows）`C:\mc\NapCat.Shell` 及正式服务器（2258206921）。

---

## 1. NapCat 是什么

- **NapCat** = 跑在 QQ（NTQQ）里的机器人框架：通过注入 QQ 进程，把 QQ 的收发消息封装成 **OneBot11 协议**，并支持**原生插件**（JS/ESM 模块）开发。
- 它**不是独立程序**，必须先有 QQ 本体（Windows 版 QQ 9.x），NapCat 注入运行。没有 QQ = 无法工作。
- 官方文档：`https://napneko.github.io/`（可查协议/配置）。

## 2. 关键目录（Windows 版，NapCat.Shell）

| 路径 | 说明 |
|---|---|
| `napcat.mjs` | **NapCat 主程序**（压缩单文件，3MB）。**已被手动补丁**：白名单（checkin/debug 插件）+ Rkey 日志降级。**升级会覆盖，需重新打补丁** |
| `launcher.bat` | 启动器（管理员）。**从注册表找 QQ 路径**，找不到报 `provided QQ path is invalid`（绿色版 QQ 需改脚本或补注册表） |
| `config/napcat.json` | 核心配置（端口、日志级别等） |
| `config/onebot11_<QQ号>.json` | 每个 QQ 的 OneBot 连接配置（HTTP/WS server/client）。**含 token、reportSelfMessage、messagePostFormat** |
| `config/plugins/` | **插件配置目录**（含 apiKey 等敏感信息，被 .gitignore 忽略） |
| `plugins/` | **原生插件目录**（checkin、deepseek、napcat-plugin-debug） |
| `plugins/<插件>/data/` | 插件数据（按需自建） |
| `logs/` | 日志（config/napcat.json 可开 fileLog） |

## 3. 原生插件开发（核心）

一个插件 = `plugins/<id>/` 目录 + `package.json` + `index.mjs`，导出：

```js
// index.mjs 顶层导出
export async function plugin_init(ctx) { /* 初始化：logger、_ctx 存好、定时器 */ }
export async function plugin_onmessage(event, ctx) { /* 群/私聊消息事件 */ }
```

**ctx 关键字段**（plugin_init/onmessage 第二个参数）：
- `ctx.logger`：日志（info/warn/error）
- `ctx.configPath`：插件配置文件路径（NapCat 自动建 `config/plugins/<id>/config.json`）
- `ctx.actions`：调 OneBot API 用：`ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config)`
- 数据文件：自己 `fs` 读写，建议放 `path.dirname(ctx.configPath)`（= `config/plugins/<id>/`）或插件目录 `data/`

**消息事件 event 关键字段**（OneBot11 群消息）：
- `post_type='message'`、`message_type='group'`
- `group_id`、`user_id`、`self_id`、`message`（array 或 string，取决于 messagePostFormat）
- 提取文本：`message` 数组里 `type==='text'` 段拼接 `.trim()`

**发消息**：
```js
await ctx.actions.call('send_msg', { message_type: 'group', group_id: '123', message: 'hello' }, ctx.adapterName, ctx.pluginManager.config);
```
（图片消息：`message: [{type:'image', data:{file:'文件路径或URL'}}]`）

**配置读写**（每次实时读，改完立即生效）：
```js
const cfg = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
```

## 4. debug 插件 JSON-RPC（热重载神器）

debug 插件监听 `ws://127.0.0.1:8998`（配置里 token 空则免密），标准 JSON-RPC：

```json
{"jsonrpc":"2.0","method":"getLoadedPlugins","params":[],"id":1}
{"jsonrpc":"2.0","method":"reloadPlugin","params":["napcat-plugin-checkin"],"id":2}   // ← 参数是数组！不是对象
{"jsonrpc":"2.0","method":"getPluginInfo","params":["..."],"id":3}
```

- **改插件 index.mjs → reloadPlugin 热重载，无需重启 NapCat**
- 改 `gen_*.py` 免重载（Python 每次独立进程）
- **改 napcat.mjs / config/onebot11_*.json → 必须重启 NapCat**
- 响应 `result: true` = 成功；`false` = 失败（多半是参数格式错）

## 5. 血泪教训（本会话踩过的坑）

1. **机器人收不到自己发的消息（self 消息）**：`send_msg` 后 OneBot **不会回推给自己**。`reportSelfMessage: true` 配置了也不生效（QQNT 不产生 self RawMessage，NapCat 这条路径走不通）。→ 别依赖"识别自己发的消息"。
2. **读自己发的消息的替代方案**：NapCat 扩展 action `get_group_msg_history`（`{group_id, count}`）**能取到自己发的消息**（含 `message_sent_type:'self'`、`message_id`）。→ 可用"轮询历史"实现（checkin 的领取积分就这么做的：每 3 秒拉 20 条、过滤 self、message_id 去重、60 秒新鲜度）。
3. **onebot11 WS 多配置同端口会打架**：本机两个 QQ 配置都写 4955，实际只认最后一个（token 不匹配的连接 open 后被踢，code 1005）。插件连接要"多候选逐个试 + 保持时长判定认证"。
4. **热重载不销毁旧实例的定时器**：reloadPlugin 后旧模块的 setTimeout/连接还在。→ 用 `globalThis.__xxx` 做实例接管（新实例关旧的、旧实例醒来发现被接管就退出）。
5. **QQ 版本偏移警告**：`未找到对应版本的偏移数据: 9.9.33-51802` = QQ 版本太新，NapCat 偏移表没有。建议用 9.9.22/9.9.32 稳定版，别用测试版。
6. **Rkey 日志刷屏**：NapCat 内置两个第三方 Rkey 服务不可达时每次发图刷 error。已降级为 debug（napcat.mjs 补丁，3 处备份 `bak_rkeylog*`）。
7. **白名单**：`napcat.mjs` 内置插件白名单需手动加 `napcat-plugin-checkin`/`napcat-plugin-debug`，**NapCat 升级覆盖后要重加**（备份 `napcat.mjs.bak_20260805`）。
8. **插件动态 `import('ws')` 可能失败**：NapCat 环境建议静态 import（它自带 ws 依赖）。
9. **fetch failed**：插件里 node fetch 调外部 API 失败多为网络（服务器出外网受限），本机 curl 可测；与 key 无关时优先查服务器网络。

## 6. 本工作区已有插件（可参考/复用）

| 插件 | 能力 | 关键实现 |
|---|---|---|
| `plugins/checkin/` | 签到/积分/发言排行/竞猜/游戏名绑定/游戏内领取积分（轮询历史实现） | index.mjs + gen_poster.py(海报) + data/ |
| `plugins/deepseek/` | @机器人聊天 + `wiki 问题`知识库问答（全文模式，知识库文件 mtime 热更新）+ `搜索 xxx`联网 + `upwiki`群主修正记录 + 缓存价记账 | 知识库 `knowledge/知识库_玩家版.md`，config 有 apiKey/dailyBudgetYuan |
| `plugins/napcat-plugin-debug/` | 8998 JSON-RPC 调试（getLoadedPlugins/reloadPlugin 等） | — |

## 7. 与「FastAPI 核心 + 机器人客户端」架构的对接建议

你的新架构（FastAPI 管数据/提醒/检索/AI，网页和 QQ 机器人都是客户端）在 NapCat 侧只需要一个**薄客户端插件**：

- **机器人发消息给 FastAPI**：插件里用 node `fetch` POST 到 FastAPI（如 `http://127.0.0.1:8000/api/chat`），`JSON.stringify` 带 `{group_id, user_id, text}`。注意服务器出外网/防火墙（腾讯云安全组）。
- **FastAPI 主动推给机器人**：两选一
  - **反向 WS**：NapCat 配 `websocketClients`（`config/onebot11_*.json` 的 `network.websocketClients`，NapCat 主动连你的 FastAPI WS），FastAPI 用 `send_msg` 推送。
  - 或 FastAPI 起 WS server，插件 `import('ws')` 连它并监听推送 → 调 `ctx.actions.call('send_msg', ...)`。
- **多群隔离**：数据按 `group_id + user_id` 做 key（checkin 的模式）。
- **权限**：群主判断用 `ctx.actions.call('get_group_info', {group_id})` 取 owner 或手动配置 ownerQq。
- **提醒（定时任务）**：插件里 `setInterval`/`setTimeout`，注意热重载残留（见坑 4），或把提醒放 FastAPI 端（更稳）。

## 8. 常用操作速查

```bash
# 启动 NapCat（Windows）
# 管理员运行 launcher.bat（绿色版 QQ 需改脚本指定 QQPath 或补注册表）

# 热重载插件（NapCat 运行时）
node -e "连接 ws://127.0.0.1:8998，发 reloadPlugin"

# 查 QQ 版本（判断偏移表匹配）
# QQ 安装目录 resources/app/package.json 的 version

# 备份/恢复 napcat.mjs
cp napcat.mjs napcat.mjs.bak_日期   # 改前必备份
```

## 9. 环境信息

- 本机 QQ：绿色版 `C:\game\qq`（当前 9.9.33-51802，NapCat 偏移表最高 9.9.32，有警告但不影响主要功能）
- 本机 NapCat：`C:\mc\NapCat.Shell`，本地测试 QQ 3020150374（4955 WS，token `5VWQUZ-5ZnR.ZgCP`）
- 正式服务器：QQ 2258206921（用户自行部署，config 含正式 apiKey）
- 云服务器（Ubuntu）：`/home/ubuntu/Napcat`（另一套，Linux 适配：python3 + Noto 字体，用 sync_cloud.sh 同步）
