// test-quiet-hours.mjs — 时段静默（src/quiet-hours.js）的自包含检查。
// 跑法：node scripts/test-quiet-hours.mjs
import { parseQuietHm, normalizeQuietHours, quietHoursActive } from '../src/quiet-hours.js';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures++; console.log(`❌ ${label}`); }
}

const at = (h, m = 0) => new Date(2026, 9, 27, h, m);

// parseQuietHm
ok(parseQuietHm('23:30') === 23 * 60 + 30, 'parseQuietHm 正常解析');
ok(parseQuietHm('7:05') === 7 * 60 + 5, 'parseQuietHm 单位数小时');
ok(parseQuietHm('24:00') === null && parseQuietHm('12:60') === null, 'parseQuietHm 拒绝越界');
ok(parseQuietHm('') === null && parseQuietHm('abc') === null, 'parseQuietHm 拒绝乱输入');

// normalizeQuietHours
const n1 = normalizeQuietHours({ enabled: true, scope: 'xxx', ranges: [['23:30', '07:00'], ['bad', 'x'], 'junk', ['12:00', '12:00']] });
ok(n1.enabled === true && n1.scope === 'all' && n1.ranges.length === 1 && n1.ranges[0][0] === '23:30', 'normalize 过滤非法/零长时段并兜底 scope');
ok(normalizeQuietHours({ enabled: 1, ranges: [] }).enabled === false, 'normalize enabled 严格要求 true');
const n2 = normalizeQuietHours({ enabled: true, ranges: Array.from({ length: 12 }, (_, i) => [`0${i % 10}`.slice(-2) + ':00', `0${(i + 1) % 10}`.slice(-2) + ':00']) });
ok(n2.ranges.length === 8, 'normalize 最多保留 8 段');
ok(normalizeQuietHours(null).ranges.length === 0 && normalizeQuietHours(undefined).enabled === false, 'normalize 空输入安全');

// quietHoursActive — 普通区间
const day = { enabled: true, scope: 'all', ranges: [['12:00', '13:30']] };
ok(quietHoursActive(day, 'group:123', at(12, 30)) === true, '区间内命中');
ok(quietHoursActive(day, 'group:123', at(13, 30)) === false, '区间右端点开');
ok(quietHoursActive(day, 'group:123', at(11, 59)) === false, '区间前不命中');

// quietHoursActive — 跨零点
const night = { enabled: true, scope: 'all', ranges: [['23:30', '07:00']] };
ok(quietHoursActive(night, 'group:123', at(23, 45)) === true, '跨零点：前半夜命中');
ok(quietHoursActive(night, 'private:456', at(0, 30)) === true, '跨零点：凌晨命中');
ok(quietHoursActive(night, 'group:123', at(12, 0)) === false, '跨零点：中午不命中');
ok(quietHoursActive(night, 'group:123', at(7, 0)) === false, '跨零点：结束点开');

// quietHoursActive — scope / 开关 / 边界
ok(quietHoursActive({ ...night, scope: 'groups' }, 'private:456', at(0, 30)) === false, 'scope=groups 时私聊不受影响');
ok(quietHoursActive({ ...night, scope: 'groups' }, 'group:123', at(0, 30)) === true, 'scope=groups 时群聊受影响');
ok(quietHoursActive({ ...night, enabled: false }, 'group:123', at(0, 30)) === false, '总开关关闭不生效');
ok(quietHoursActive({ enabled: true, ranges: [] }, 'group:123', at(0, 30)) === false, '无时段不生效');
ok(quietHoursActive({ enabled: true, ranges: [['12:00', '12:00']] }, 'group:123', at(12, 0)) === false, '起止相同视为无效');
ok(quietHoursActive(null, 'group:123', at(0, 30)) === false, '无配置不生效');

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
