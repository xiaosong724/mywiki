import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Lunar = null;
try {
  ({ Lunar } = require('lunar-javascript'));
} catch (err) {
  console.warn('[lunar] 农历库加载失败:', err.message);
}

// 农历 (year, month, day) -> 阳历本地 09:00 Date；非法返回 null
export function lunarToSolar(year, month, day) {
  if (!Lunar) return null;
  try {
    const solar = Lunar.fromYmd(year, month, day).getSolar();
    return new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay(), 9, 0, 0);
  } catch {
    return null;
  }
}

// 找下一次农历 (month, day) 的阳历日期（今年若已过则明年）
export function nextLunarDate(month, day, now = new Date()) {
  if (!Lunar) return null;
  let d = lunarToSolar(now.getFullYear(), month, day);
  if (d && d < now) d = lunarToSolar(now.getFullYear() + 1, month, day);
  return d;
}
