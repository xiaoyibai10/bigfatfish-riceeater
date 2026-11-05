'use strict';

/**
 * api/_lib/validate.js
 * 入参校验与归一化。全部为纯函数，方便单测与复用。
 *
 * 所有规则严格对齐 docs/SPEC.md §5：
 *  - deviceId：严格 UUID 正则（版本 1-5、variant 8/9/a/b）；
 *  - nickname：去控制字符 + trim，1-20 个 Unicode 字符，空则「匿名肥鱼」；
 *  - totalRice：有限数字，0 ~ 10,000,000，四舍五入到 1 位小数；
 *  - limit：1-100 的整数，缺省 50。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 设备标识 UUID 正则（与 SPEC 完全一致，大小写不敏感）。 */
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 昵称为空时的默认值。 */
const DEFAULT_NICKNAME = '匿名肥鱼';

/** 昵称最大长度（按 Unicode 码点计算）。 */
const MAX_NICKNAME_LENGTH = 20;

/** 白饭总量上限：一千万碗。 */
const MAX_TOTAL_RICE = 10000000;

/** 榜单条数上限与默认值。 */
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * 需要剔除的不可见字符：
 *  - C0 / C1 控制字符（换行、制表、退格等）；
 *  - 零宽字符与方向控制符（常被用来伪造昵称长度 / 欺骗展示）。
 */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

// ---------------------------------------------------------------------------
// deviceId
// ---------------------------------------------------------------------------

/**
 * 判断 deviceId 是否为合法 UUID。
 * 注意：不做 trim、不做大小写转换，空格或多余字符一律视为非法。
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidDeviceId(value) {
  return typeof value === 'string' && DEVICE_ID_RE.test(value);
}

// ---------------------------------------------------------------------------
// nickname
// ---------------------------------------------------------------------------

/**
 * 归一化昵称：
 *  1. 非字符串按空串处理；
 *  2. 去掉控制字符与零宽字符；
 *  3. trim；
 *  4. 空串回落到「匿名肥鱼」；
 *  5. 超过 20 个 Unicode 字符则截断到 20（emoji 不会被截成半个）。
 * @param {unknown} input
 * @returns {string}
 */
function normalizeNickname(input) {
  const raw = typeof input === 'string' ? input : '';
  const cleaned = raw.replace(CONTROL_CHARS_RE, '');
  const trimmed = cleaned.trim();
  if (!trimmed) return DEFAULT_NICKNAME;

  // Array.from 按码点拆分，避免把代理对（emoji）算成两个字符。
  const chars = Array.from(trimmed);
  if (chars.length > MAX_NICKNAME_LENGTH) {
    return chars.slice(0, MAX_NICKNAME_LENGTH).join('');
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// totalRice
// ---------------------------------------------------------------------------

/**
 * 校验并归一化白饭总量。
 * 只接受真正的 number 类型（JSON 数字），字符串 / null / 布尔一律拒绝，避免隐式转换歧义。
 * @param {unknown} input
 * @returns {{ok:true,value:number}|{ok:false,code:string,message:string}}
 */
function normalizeTotalRice(input) {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return {
      ok: false,
      code: 'INVALID_TOTAL_RICE',
      message: '白饭总量必须是有限数字。'
    };
  }
  if (input < 0 || input > MAX_TOTAL_RICE) {
    return {
      ok: false,
      code: 'INVALID_TOTAL_RICE',
      message: `白饭总量必须在 0 到 ${MAX_TOTAL_RICE} 之间。`
    };
  }

  // 四舍五入到 1 位小数；加 EPSILON 规避 1.005 这类浮点误差。
  let rounded = Math.round((input + Number.EPSILON) * 10) / 10;
  if (Object.is(rounded, -0)) rounded = 0;

  // 极端情况下四舍五入后仍可能超出上限（例如 9999999.99 -> 10000000），此时按上限截断。
  if (rounded > MAX_TOTAL_RICE) rounded = MAX_TOTAL_RICE;
  if (rounded < 0) rounded = 0;

  return { ok: true, value: rounded };
}

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

/**
 * 校验并归一化榜单条数。
 * 缺省（undefined / null / 空串）返回 50；其余必须是 1-100 的整数。
 * @param {unknown} input
 * @returns {{ok:true,value:number}|{ok:false,code:string,message:string}}
 */
function normalizeLimit(input) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, value: DEFAULT_LIMIT };
  }

  let value = NaN;
  if (typeof input === 'number') {
    value = input;
  } else if (typeof input === 'string' && /^[0-9]+$/.test(input.trim())) {
    value = Number(input.trim());
  }

  if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
    return {
      ok: false,
      code: 'INVALID_LIMIT',
      message: `limit 必须是 ${MIN_LIMIT} 到 ${MAX_LIMIT} 之间的整数。`
    };
  }

  return { ok: true, value };
}

module.exports = {
  DEVICE_ID_RE,
  DEFAULT_NICKNAME,
  MAX_NICKNAME_LENGTH,
  MAX_TOTAL_RICE,
  MIN_LIMIT,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  isValidDeviceId,
  normalizeNickname,
  normalizeTotalRice,
  normalizeLimit
};
