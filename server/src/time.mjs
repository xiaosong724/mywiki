// 本地时区（Asia/Shanghai）时间工具：所有时间以本地 ISO 字符串存储（YYYY-MM-DDTHH:mm:ss）

export function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

export function toLocalISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function toLocalDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowLocalISO() {
  return toLocalISO(new Date());
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMinutes(d, n) {
  const r = new Date(d);
  r.setMinutes(r.getMinutes() + n);
  return r;
}

// 解析常见日期输入：今天/明天/后天/大后天/N天后/YYYY-MM-DD/X月X日/周X/星期X/X号；返回本地 09:00 的 Date，非法返回 null
export function parseDateInput(s, now = new Date()) {
  if (!s) return null;
  const t = String(s).trim();
  if (t === '今天') return atHour(addDays(now, 0), 9);
  if (t === '明天') return atHour(addDays(now, 1), 9);
  if (t === '后天') return atHour(addDays(now, 2), 9);
  if (t === '大后天') return atHour(addDays(now, 3), 9);
  let m = t.match(/^(\d+)天后$/);
  if (m) return atHour(addDays(now, Number(m[1])), 9);
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = t.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (m) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), 9, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // 周X / 星期X：下一个该星期（含今天）
  m = t.match(/^(周|星期)([一二三四五六日天])$/);
  if (m) {
    const wd = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[m[2]];
    if (wd !== undefined) {
      const diff = (wd - now.getDay() + 7) % 7;
      return atHour(addDays(now, diff), 9);
    }
  }
  // 下周X / 下星期X：下一周的该星期
  m = t.match(/^下(周|星期)([一二三四五六日天])$/);
  if (m) {
    const wd = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[m[2]];
    if (wd !== undefined) {
      const nextMon = addDays(now, ((1 - now.getDay() + 7) % 7) || 7);
      const offset = wd === 0 ? 6 : wd - 1; // 周日=下一周的最后一天
      return atHour(addDays(nextMon, offset), 9);
    }
  }
  // X号 / X日：本月该日，已过则顺延到下月
  m = t.match(/^(\d{1,2})(号|日)$/);
  if (m) {
    const day = Number(m[1]);
    const d = new Date(now.getFullYear(), now.getMonth(), day, 9, 0, 0);
    if (!Number.isNaN(d.getTime())) {
      if (d < now) d.setMonth(d.getMonth() + 1);
      return d;
    }
  }
  return null;
}

// 从文本里提取时间（支持 8:30 / 8：30 / 8点半 / 下午3点 / 晚上8点 / 凌晨5点），返回 {h,m} 或 null
export function extractTime(t) {
  const s = String(t || '');
  let m = s.match(/(\d{1,2})[:：](\d{1,2})/);
  if (m) return { h: Number(m[1]), m: Number(m[2]) };
  m = s.match(/(\d{1,2})点半/);
  if (m) return { h: Number(m[1]), m: 30 };
  m = s.match(/(上午|早上|凌晨|中午|下午|晚上)?\s*(\d{1,2})点/);
  if (m) {
    let h = Number(m[2]);
    if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12;
    if (m[1] === '凌晨' && h === 12) h = 0;
    return { h, m: 0 };
  }
  return null;
}

function stripTimeOfDay(t) {
  return String(t || '')
    .replace(/\d{1,2}[:：]\d{1,2}/g, ' ')
    .replace(/\d{1,2}点半/g, ' ')
    .replace(/(上午|早上|凌晨|中午|下午|晚上)?\s*\d{1,2}点/g, ' ')
    .replace(/(上午|早上|凌晨|中午|下午|晚上)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析"日期 + 可选时间"：明天8:30 / 明天下午3点 / 周五晚上8点 / 8月20日 14:00 / 2026-08-20 14:30 / 3号 12点半
// 返回本地 Date（时间缺省 09:00），非法返回 null
export function parseDateTimeInput(s, now = new Date()) {
  const t = String(s || '').trim();
  if (!t) return null;
  const time = extractTime(t);
  const dateStr = time ? stripTimeOfDay(t) : t;
  const d = parseDateInput(dateStr, now);
  if (!d) return null;
  if (time) d.setHours(time.h, time.m, 0, 0);
  return d;
}

// 相对时间：当前时间 + 偏移，如 一分钟后 / 半小时后 / 10分钟后 / 2小时后 / 1小时30分钟后 / 一刻钟后
// 返回 Date 或 null
export function parseRelativeTime(s, now = new Date()) {
  const t = String(s || '').trim();
  if (!t) return null;
  const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
  const toNum = (x) => (/^\d+$/.test(x) ? Number(x) : cn[x] ?? null);
  let m;
  m = t.match(/^(\d+|[一二两三四五六七八九十半])小时(\d+|[一二两三四五六七八九十半])分钟?后$/);
  if (m) {
    const h = toNum(m[1]);
    const mi = toNum(m[2]);
    if (h !== null && mi !== null) return addMinutes(now, Math.round(h * 60 + mi));
  }
  m = t.match(/^(\d+|[一二两三四五六七八九十半])分钟?后$/);
  if (m) {
    const n = toNum(m[1]);
    if (n !== null) return addMinutes(now, Math.round(n)); // 分钟 = n 分钟
  }
  m = t.match(/^(\d+|[一二两三四五六七八九十半])小时?后$/);
  if (m) {
    const n = toNum(m[1]);
    if (n !== null) return addMinutes(now, Math.round(n * 60)); // 小时 = n*60 分钟
  }
  if (/^一刻钟后$/.test(t)) return addMinutes(now, 15);
  return null;
}

export function atHour(d, hour = 9) {
  const r = new Date(d);
  r.setHours(hour, 0, 0, 0);
  return r;
}

export function isSameLocalDate(a, b) {
  return toLocalDateStr(a) === toLocalDateStr(b);
}
