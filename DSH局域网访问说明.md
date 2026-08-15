# DSH 局域网访问说明（2026-08-16）

> 目的：本机浏览器（或局域网内其它设备）用 `http://192.168.31.180:3080` 访问 DeepSeek Harness 网页界面。
> 相关路径：DSH 安装在 `C:\Users\49553\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`；配置在 `C:\Users\49553\.dsh\`。

## 1. 开启局域网监听

`dsh web` 默认只绑定 `127.0.0.1`，且**命令行 `--host 0.0.0.0` 被 DSH 显式拒绝**（安全考虑）。
通过 profile 补丁覆盖默认绑定（保留 `!!js` 表达式，`--host/--port` 仍可覆盖）：

文件：`C:\Users\49553\.dsh\profiles\web\cordis.patch.yml`

```yaml
- id: webserver
  config:
    host: !!js ctx.webStartup.host ?? '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
```

- 绑定 `0.0.0.0` 后，web 运行时自动枚举本机局域网 IPv4 并加入**信任围栏**（`dsh-web-app` 的 `resolveLanTrust`），启动日志会打印 `LAN: http://<本机IP>:3080`。
- ⚠️ 安全：0.0.0.0 会把 DSH（可在工作区执行任意命令的界面）暴露给整个局域网。仅限可信家庭局域网；可用 Windows 防火墙限制来源；不用时改回 `'127.0.0.1'`。

## 2. crypto.randomUUID 兼容补丁（必须）

局域网 IP 走的是明文 HTTP，**不是浏览器"安全上下文"**，而 `crypto.randomUUID` 只在安全上下文可用
（DSH 前端代码多处直接调用它，如 RPC id 生成）→ 报 `crypto.randomUUID is not a function`（工作区选择器必现）。

补丁位置：`node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html`，在 `<script type="module">` 之前注入：

```html
<script>
(function () {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
      crypto.randomUUID = function () {
        var bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        var hex = Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
      };
    }
  } catch (e) {}
})();
</script>
```

（用 `crypto.getRandomValues` 实现 RFC4122 v4——它在非安全上下文也可用。）

**注意**：补丁写在 dist 里，`@deepseek-ai/dsh` 升级/重装后需要**重新注入**；浏览器侧需 Ctrl+F5 强刷。

## 3. 备选方案（本机浏览器，不改代码）

用浏览器启动参数把局域网地址标记为安全上下文（仅对带参数启动的浏览器实例生效）：

- Edge：`msedge.exe --unsafely-treat-insecure-origin-as-secure="http://192.168.31.180:3080"`
- Chrome：`chrome.exe --unsafely-treat-insecure-origin-as-secure="http://192.168.31.180:3080"`

## 4. 验证

- `netstat -ano | findstr 3080`：应为 `0.0.0.0:3080 LISTENING`
- 会话数据只有一份（`C:\Users\49553\.dsh\sessions\`），本地/局域网访问同一份，无需"同步"；
  两个窗口看到的是同一个实时会话。浏览器本地状态（当前会话、UI 偏好）按 origin 隔离是正常现象。
