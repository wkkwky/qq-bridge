// 时段静默（quiet hours）：本地时间的免打扰时段。命中时段时桥接丢弃计划唤醒（不暂存、不补发）。
// 纯函数模块，方便独立测试；桥接侧与控制台共用它做判定与归一化。

// "23:30" -> 1410（分钟数）；非法输入返回 null。
export function parseQuietHm(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// 归一化配置：非法/零长（起=止）的时段直接丢弃，最多保留 8 段。
export function normalizeQuietHours(input) {
  const src = input && typeof input === 'object' ? input : {};
  const ranges = (Array.isArray(src.ranges) ? src.ranges : [])
    .map((r) => {
      if (!Array.isArray(r)) return null;
      const s = parseQuietHm(r[0]);
      const e = parseQuietHm(r[1]);
      if (s == null || e == null || s === e) return null;
      return [String(r[0]).trim(), String(r[1]).trim()];
    })
    .filter(Boolean)
    .slice(0, 8);
  return { enabled: src.enabled === true, scope: src.scope === 'groups' ? 'groups' : 'all', ranges };
}

// 当前（或给定时刻）是否落在静默时段内。跨零点区间（如 23:30-07:00）按环绕处理；
// scope='groups' 时私聊不受影响。
export function quietHoursActive(qh, key, now = new Date()) {
  if (!qh || qh.enabled !== true) return false;
  if (qh.scope === 'groups' && !String(key ?? '').startsWith('group:')) return false;
  const ranges = (Array.isArray(qh.ranges) ? qh.ranges : [])
    .map((r) => (Array.isArray(r) ? [parseQuietHm(r[0]), parseQuietHm(r[1])] : null))
    .filter((r) => r && r[0] != null && r[1] != null && r[0] !== r[1]);
  if (!ranges.length) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return ranges.some(([s, e]) => (s <= e ? mins >= s && mins < e : mins >= s || mins < e));
}
