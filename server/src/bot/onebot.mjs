// OneBot11 适配器：连接 NapCat（或其他 OneBot11 兼容机器人）的 WS 服务端
// 换机器人 = 换 kind/配置，本文件就是"适配器"的唯一实现点

export function extractText(message) {
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) {
    return message
      .filter((s) => s.type === 'text')
      .map((s) => s.data?.text || '')
      .join('')
      .trim();
  }
  return '';
}

export class OneBotClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.retryTimer = null;
    this.pending = new Map();
    this.echoSeq = 0;
    this.retryDelay = 5000;
    this.onMessage = null;
    this.onStatus = null;
    this.loggedFail = false;
  }

  url() {
    const t = this.cfg.token ? `?access_token=${encodeURIComponent(this.cfg.token)}` : '';
    return `ws://${this.cfg.host}:${this.cfg.port}/${t}`;
  }

  start() {
    this.connect();
  }

  connect() {
    try {
      const ws = new WebSocket(this.url());
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.loggedFail = false;
        console.log(`[bot] 已连接 OneBot WS ${this.cfg.host}:${this.cfg.port}`);
        this.onStatus?.(true);
      };
      ws.onmessage = (e) => this.handleMessage(String(e.data));
      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        this.onStatus?.(false);
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        try { ws.close(); } catch { /* noop */ }
      };
    } catch (err) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.retryTimer || !this.cfg.enabled) return;
    if (!this.loggedFail) {
      this.loggedFail = true;
      console.log(`[bot] 未连上 OneBot WS（NapCat 未启动？），每 ${this.retryDelay / 1000}s 重试…`);
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);
  }

  stop() {
    this.cfg.enabled = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try { this.ws?.close(); } catch { /* noop */ }
  }

  handleMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.echo !== undefined) {
      const p = this.pending.get(String(msg.echo));
      if (p) {
        this.pending.delete(String(msg.echo));
        p.resolve(msg);
      }
      return;
    }
    if (msg.post_type === 'message') {
      this.onMessage?.(msg);
    }
  }

  call(action, params, timeoutMs = 10000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('bot 未连接'));
    const echo = `e${++this.echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`onebot 超时: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err);
      }
    });
  }

  async sendMessage({ message_type = 'private', id, text }) {
    if (!this.connected) return false;
    const params = message_type === 'group'
      ? { message_type: 'group', group_id: Number(id), message: text }
      : { message_type: 'private', user_id: Number(id), message: text };
    try {
      const res = await this.call('send_msg', params);
      const ok = res?.retcode === 0 || res?.status === 'ok';
      if (!ok) console.warn('[bot] send_msg 未成功:', JSON.stringify(res));
      return ok;
    } catch (err) {
      console.warn('[bot] send_msg 异常:', err.message);
      return false;
    }
  }

  async getGroupMemberInfo(groupId, userId) {
    if (!this.connected) return null;
    try {
      const res = await this.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
      });
      if (res?.data) return res.data;
      if (res?.retcode === 0) return res;
      return null;
    } catch {
      return null;
    }
  }

  // 归一化的成员角色查询：{found:true, role} | {found:false}（明确非成员）| null（网络失败=未知）
  async getMemberRole(groupId, userId) {
    if (!this.connected) return null;
    try {
      const res = await this.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
      });
      if (res?.retcode === 0 && res?.data) return { found: true, role: String(res.data.role || 'member') };
      return { found: false };
    } catch {
      return null;
    }
  }
}
