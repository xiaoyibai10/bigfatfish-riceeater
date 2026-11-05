'use strict';

/**
 * api/rank/top.js
 * GET /api/rank/top?limit=50&deviceId=<uuid> —— 公开干饭榜。
 *
 * 行为摘要：
 *  - 只接受 GET；OPTIONS 返回 204；其它方法 405；
 *  - limit：1-100，默认 50，通过 Supabase 的 .limit() 下推到数据库；
 *  - deviceId 可选且必须是合法 UUID，用于返回「我的排名」；
 *  - 返回 {ok, updatedAt, ranks:[{rank,nickname,totalRice,updatedAt}], me}；
 *  - 任何情况下都不把 device_id 返回给客户端；
 *  - me 的名次 = count(total_rice > 我的 total_rice) + 1；
 *  - 空榜返回 ranks: []，me 为 null；
 *  - 缺 env / 数据库异常 / 8 秒超时全部返回 JSON，不泄露内部信息。
 */

const {
  SUPABASE_TIMEOUT_MS,
  handlePreflight,
  sendJson,
  withTimeout,
  isTimeoutError,
  safeErrorInfo
} = require('../_lib/http');
const { getSupabaseClient } = require('../_lib/supabase');
const { isValidDeviceId, normalizeLimit } = require('../_lib/validate');

/** 日志前缀。 */
const ROUTE = 'api/rank/top';

/** 榜单展示时兜底的昵称（数据库有 not null，但不排除历史脏数据）。 */
const FALLBACK_NICKNAME = '匿名肥鱼';

/**
 * 从查询参数中取单个值（Vercel 对重复参数可能返回数组）。
 * @param {unknown} value
 * @returns {unknown}
 */
function firstQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 获取查询参数对象。
 * 优先使用 Vercel 提供的 req.query；缺失时从 req.url 手动解析，方便本地测试。
 * @param {object} req
 * @returns {Record<string, unknown>}
 */
function getQuery(req) {
  if (req && req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    return req.query;
  }
  try {
    const rawUrl = req && typeof req.url === 'string' ? req.url : '';
    const url = new URL(rawUrl, 'http://localhost');
    const query = {};
    for (const [key, value] of url.searchParams.entries()) query[key] = value;
    return query;
  } catch (error) {
    return {};
  }
}

/**
 * 把数据库里的 numeric / 字符串转成 1 位小数数字。
 * @param {unknown} value
 * @returns {number}
 */
function toRiceNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  const rounded = Math.round(num * 10) / 10;
  return rounded >= 0 ? rounded : 0;
}

/**
 * 把 timestamptz / 数字转成毫秒时间戳。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toMilliseconds(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 兼容数据库里存秒级时间戳的历史数据。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 构造数据库查询失败错误（只用于内部抛出，不直接返回客户端）。
 * @param {unknown} cause Supabase 返回的 error 对象
 * @returns {Error}
 */
function databaseError(cause) {
  const error = new Error('排行榜数据库查询失败');
  error.code = 'DB_QUERY_FAILED';
  error.cause = cause;
  return error;
}

/**
 * 读取一次榜单快照（含可选的「我的排名」）。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} limit
 * @param {string|null} deviceId
 * @returns {Promise<{ranks:Array, me:object|null, updatedAt:number}>}
 */
async function fetchSnapshot(supabase, limit, deviceId) {
  // 只 select 展示需要的列，device_id 永远不出库。
  const listResult = await supabase
    .from('rankings')
    .select('nickname, total_rice, updated_at')
    .order('total_rice', { ascending: false })
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (listResult.error) throw databaseError(listResult.error);

  const rows = Array.isArray(listResult.data) ? listResult.data : [];
  const ranks = rows.map((row, index) => ({
    rank: index + 1,
    nickname:
      row && typeof row.nickname === 'string' && row.nickname
        ? row.nickname.slice(0, 20)
        : FALLBACK_NICKNAME,
    totalRice: toRiceNumber(row && row.total_rice),
    updatedAt: toMilliseconds(row && row.updated_at, 0)
  }));

  // 顶层 updatedAt：取本次返回数据里最新的更新时间；空榜时退回当前时间。
  let updatedAt = 0;
  for (const item of ranks) {
    if (item.updatedAt > updatedAt) updatedAt = item.updatedAt;
  }

  let me = null;
  if (deviceId) {
    const meResult = await supabase
      .from('rankings')
      .select('nickname, total_rice, updated_at')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (meResult.error) throw databaseError(meResult.error);

    if (meResult.data) {
      const myRice = toRiceNumber(meResult.data.total_rice);
      const myUpdatedAt = toMilliseconds(meResult.data.updated_at, 0);

      // 名次 = 严格比我饭多的人数 + 1（并列时名次相同）。
      const higherResult = await supabase
        .from('rankings')
        .select('*', { count: 'exact', head: true })
        .gt('total_rice', myRice);

      if (higherResult.error) throw databaseError(higherResult.error);

      const higherRaw = Number(higherResult.count);
      const higher = Number.isFinite(higherRaw) && higherRaw > 0 ? Math.trunc(higherRaw) : 0;

      me = {
        rank: higher + 1,
        nickname:
          typeof meResult.data.nickname === 'string' && meResult.data.nickname
            ? meResult.data.nickname.slice(0, 20)
            : FALLBACK_NICKNAME,
        totalRice: myRice
      };

      if (myUpdatedAt > updatedAt) updatedAt = myUpdatedAt;
    }
  }

  if (!updatedAt) updatedAt = Date.now();

  return { ranks, me, updatedAt };
}

/**
 * Vercel Serverless 入口。
 * @param {object} req 请求对象
 * @param {object} res 响应对象
 * @returns {Promise<void>}
 */
module.exports = async function handler(req, res) {
  try {
    // 1. CORS 预检。
    if (handlePreflight(req, res)) return;

    // 2. 方法校验：只读接口。
    if (!req || req.method !== 'GET') {
      if (res && typeof res.setHeader === 'function') res.setHeader('Allow', 'GET, OPTIONS');
      sendJson(res, 405, {
        ok: false,
        code: 'METHOD_NOT_ALLOWED',
        message: '该接口只支持 GET 请求。'
      });
      return;
    }

    // 3. 查询参数校验。
    const query = getQuery(req);

    const limitResult = normalizeLimit(firstQueryValue(query.limit));
    if (!limitResult.ok) {
      sendJson(res, 400, {
        ok: false,
        code: limitResult.code,
        message: limitResult.message
      });
      return;
    }

    const rawDeviceId = firstQueryValue(query.deviceId);
    let deviceId = null;
    if (rawDeviceId !== undefined && rawDeviceId !== null && rawDeviceId !== '') {
      if (!isValidDeviceId(rawDeviceId)) {
        sendJson(res, 400, {
          ok: false,
          code: 'INVALID_DEVICE_ID',
          message: 'deviceId 必须是合法的 UUID。'
        });
        return;
      }
      deviceId = rawDeviceId.toLowerCase();
    }

    // 4. 懒加载 Supabase 客户端；缺 env 时转换成结构化 500。
    let supabase;
    try {
      supabase = getSupabaseClient();
    } catch (error) {
      if (error && error.code === 'CONFIG_MISSING') {
        console.error(`[${ROUTE}] 服务端配置缺失：${error.message}`);
        sendJson(res, 500, {
          ok: false,
          code: 'CONFIG_MISSING',
          message: '服务端未配置数据库，暂时无法查询排行榜。'
        });
        return;
      }
      throw error;
    }

    // 5. 查询数据库（整体 8 秒超时）。
    const snapshot = await withTimeout(
      fetchSnapshot(supabase, limitResult.value, deviceId),
      SUPABASE_TIMEOUT_MS
    );

    // 6. 只返回展示字段，绝不包含 device_id。
    sendJson(res, 200, {
      ok: true,
      updatedAt: snapshot.updatedAt,
      ranks: snapshot.ranks,
      me: snapshot.me
    });
  } catch (error) {
    // 7. 统一异常兜底。
    if (isTimeoutError(error)) {
      console.error(`[${ROUTE}] Supabase 调用超时（>${SUPABASE_TIMEOUT_MS}ms）。`);
      sendJson(res, 504, {
        ok: false,
        code: 'SUPABASE_TIMEOUT',
        message: '数据库响应超时，请稍后再试。'
      });
      return;
    }

    if (error && error.code === 'DB_QUERY_FAILED') {
      console.error(`[${ROUTE}] 数据库查询失败：`, JSON.stringify(safeErrorInfo(error.cause || error)));
      sendJson(res, 500, {
        ok: false,
        code: 'DB_ERROR',
        message: '数据库查询失败，请稍后再试。'
      });
      return;
    }

    console.error(`[${ROUTE}] 未预期的异常：`, JSON.stringify(safeErrorInfo(error)));
    sendJson(res, 500, {
      ok: false,
      code: 'DB_ERROR',
      message: '服务器内部错误，请稍后再试。'
    });
  }
};
