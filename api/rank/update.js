'use strict';

/**
 * api/rank/update.js
 * POST /api/rank/update —— 匿名上报「白饭总量」。
 *
 * 行为摘要：
 *  - 只接受 POST；OPTIONS 返回 204；其它方法 405；
 *  - 请求体上限 4KB，非法 JSON / 非对象 400；
 *  - 校验 deviceId（严格 UUID）、nickname（1-20 字符）、totalRice（0 ~ 1e7，1 位小数）；
 *  - 通过 Supabase RPC report_rank 原子落库（防作弊逻辑全部在数据库内完成）；
 *  - 被防作弊拦截时返回 HTTP 200 + rejected:true，方便扩展直接展示原因；
 *  - 缺环境变量 500 CONFIG_MISSING；数据库异常 500 DB_ERROR；8 秒超时 504 SUPABASE_TIMEOUT；
 *  - 日志只输出错误码与截断后的信息，绝不输出密钥、SQL 或堆栈。
 */

const {
  MAX_BODY_BYTES,
  SUPABASE_TIMEOUT_MS,
  handlePreflight,
  sendJson,
  readJsonBody,
  withTimeout,
  isTimeoutError,
  safeErrorInfo
} = require('../_lib/http');
const { getSupabaseClient } = require('../_lib/supabase');
const { isValidDeviceId, normalizeNickname, normalizeTotalRice } = require('../_lib/validate');

/** 日志前缀。 */
const ROUTE = 'api/rank/update';

/**
 * 把 RPC 返回值整理成对象。
 * PostgREST 对 returns jsonb 的函数一般直接返回对象；兼容数组包裹 / 字符串两种极端情况。
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeRpcPayload(raw) {
  let data = raw;
  if (Array.isArray(data)) data = data[0];
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (error) {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

/**
 * 把数据库返回的数值安全地转成 1 位小数数字。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toRiceNumber(value, fallback) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num * 10) / 10;
  return rounded >= 0 ? rounded : fallback;
}

/**
 * 发送前置校验类错误（400）。
 * @param {object} res
 * @param {{code:string,message:string}} detail
 */
function sendBadRequest(res, detail) {
  sendJson(res, 400, {
    ok: false,
    rejected: false,
    code: detail.code,
    message: detail.message
  });
}

/**
 * Vercel Serverless 入口。
 * @param {object} req 请求对象（Vercel 已解析 body，或本地 Node 可读流）
 * @param {object} res 响应对象
 * @returns {Promise<void>}
 */
module.exports = async function handler(req, res) {
  try {
    // 1. CORS 预检。
    if (handlePreflight(req, res)) return;

    // 2. 方法校验：该接口只写不读，仅允许 POST。
    if (!req || req.method !== 'POST') {
      if (res && typeof res.setHeader === 'function') res.setHeader('Allow', 'POST, OPTIONS');
      sendJson(res, 405, {
        ok: false,
        rejected: false,
        code: 'METHOD_NOT_ALLOWED',
        message: '该接口只支持 POST 请求。'
      });
      return;
    }

    // 3. 读取请求体（4KB 上限 + JSON 对象校验）。
    const parsedBody = await readJsonBody(req, MAX_BODY_BYTES);
    if (!parsedBody.ok) {
      sendBadRequest(res, { code: parsedBody.code, message: parsedBody.message });
      return;
    }
    const body = parsedBody.value;

    // 4. 入参校验。顺序与 SPEC 一致：先 deviceId，再 totalRice，最后 nickname。
    if (!isValidDeviceId(body.deviceId)) {
      sendBadRequest(res, {
        code: 'INVALID_DEVICE_ID',
        message: 'deviceId 必须是合法的 UUID。'
      });
      return;
    }

    const riceResult = normalizeTotalRice(body.totalRice);
    if (!riceResult.ok) {
      sendBadRequest(res, { code: riceResult.code, message: riceResult.message });
      return;
    }

    const nickname = normalizeNickname(body.nickname);
    // 统一小写，避免同一个设备以大小写不同的 UUID 重复入榜。
    const deviceId = body.deviceId.toLowerCase();

    // 5. 懒加载 Supabase 客户端；缺 env 时转换成结构化 500。
    let supabase;
    try {
      supabase = getSupabaseClient();
    } catch (error) {
      if (error && error.code === 'CONFIG_MISSING') {
        console.error(`[${ROUTE}] 服务端配置缺失：${error.message}`);
        sendJson(res, 500, {
          ok: false,
          rejected: false,
          code: 'CONFIG_MISSING',
          message: '服务端未配置数据库，暂时无法上报成绩。'
        });
        return;
      }
      throw error;
    }

    // 6. 调用数据库 RPC，整体 8 秒超时。
    const rpcResult = await withTimeout(
      supabase.rpc('report_rank', {
        p_device_id: deviceId,
        p_nickname: nickname,
        p_total_rice: riceResult.value
      }),
      SUPABASE_TIMEOUT_MS
    );

    if (!rpcResult || rpcResult.error) {
      console.error(`[${ROUTE}] report_rank 调用失败：`, JSON.stringify(safeErrorInfo(rpcResult && rpcResult.error)));
      sendJson(res, 500, {
        ok: false,
        rejected: false,
        code: 'DB_ERROR',
        message: '数据库操作失败，请稍后再试。'
      });
      return;
    }

    // 7. 解析 RPC 结果。
    const payload = normalizeRpcPayload(rpcResult.data);
    if (!payload) {
      console.error(`[${ROUTE}] report_rank 返回了无法识别的数据。`);
      sendJson(res, 500, {
        ok: false,
        rejected: false,
        code: 'DB_ERROR',
        message: '数据库返回了无法识别的结果。'
      });
      return;
    }

    // 7.1 防作弊拦截：HTTP 200，便于客户端展示「成绩被没收」。
    if (payload.rejected === true || payload.ok === false) {
      const retryRaw = Number(payload.retryAfterSeconds);
      const retryAfterSeconds = Number.isFinite(retryRaw) && retryRaw > 0 ? Math.ceil(retryRaw) : 0;

      sendJson(res, 200, {
        ok: false,
        rejected: true,
        reason: typeof payload.reason === 'string' && payload.reason ? payload.reason : 'REJECTED',
        message:
          typeof payload.message === 'string' && payload.message
            ? payload.message
            : '本次成绩未被收录。',
        retryAfterSeconds
      });
      return;
    }

    // 7.2 成功。
    const rankRaw = Number(payload.rank);
    const rank = Number.isFinite(rankRaw) && rankRaw > 0 ? Math.trunc(rankRaw) : null;
    if (rank === null) {
      console.error(`[${ROUTE}] report_rank 成功但未返回合法名次。`);
      sendJson(res, 500, {
        ok: false,
        rejected: false,
        code: 'DB_ERROR',
        message: '数据库返回了无法识别的结果。'
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      rejected: false,
      rank,
      totalRice: toRiceNumber(payload.totalRice, riceResult.value),
      nickname:
        typeof payload.nickname === 'string' && payload.nickname ? payload.nickname : nickname
    });
  } catch (error) {
    // 8. 统一异常兜底：超时 504，其它 500，全部是 JSON。
    if (isTimeoutError(error)) {
      console.error(`[${ROUTE}] Supabase 调用超时（>${SUPABASE_TIMEOUT_MS}ms）。`);
      sendJson(res, 504, {
        ok: false,
        rejected: false,
        code: 'SUPABASE_TIMEOUT',
        message: '数据库响应超时，请稍后再试。'
      });
      return;
    }

    console.error(`[${ROUTE}] 未预期的异常：`, JSON.stringify(safeErrorInfo(error)));
    sendJson(res, 500, {
      ok: false,
      rejected: false,
      code: 'DB_ERROR',
      message: '服务器内部错误，请稍后再试。'
    });
  }
};
