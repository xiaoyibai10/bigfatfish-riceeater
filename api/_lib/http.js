'use strict';

/**
 * api/_lib/http.js
 * 后端通用 HTTP 工具：CORS、JSON 响应、请求体读取、超时控制。
 *
 * 设计目标：
 *  1. 任何异常最终都能落到一个 JSON 响应上，绝不让 Serverless 函数直接崩溃；
 *  2. 请求体读取自带 4KB 上限，超限立刻返回 PAYLOAD_TOO_LARGE；
 *  3. 所有 Supabase 调用统一使用 8 秒超时，避免 Vercel 函数被慢查询拖死；
 *  4. 响应头与响应体绝不包含环境变量、SQL、堆栈等内部信息。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 统一的 CORS 响应头。
 * 排行榜是公开只读接口 + 匿名上报接口，允许任意来源，方便开源插件调用。
 */
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
});

/** 请求体大小上限：4KB。排行榜请求只有一个 UUID、昵称和一个小数，足够宽裕。 */
const MAX_BODY_BYTES = 4 * 1024;

/** Supabase 调用超时：8 秒。 */
const SUPABASE_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// CORS / 响应
// ---------------------------------------------------------------------------

/**
 * 给响应写入 CORS 头。允许重复调用（setHeader 本身是幂等的）。
 * @param {object} res Vercel / Node 的响应对象
 */
function setCors(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(name, value);
  }
}

/**
 * 处理浏览器预检请求。命中 OPTIONS 时直接返回 204（无响应体）。
 * @param {object} req 请求对象
 * @param {object} res 响应对象
 * @returns {boolean} true 表示已经处理完毕，handler 应当立即 return
 */
function handlePreflight(req, res) {
  setCors(res);
  if (!req || req.method !== 'OPTIONS') return false;
  if (res && typeof res.end === 'function' && !res.writableEnded) {
    res.statusCode = 204;
    if (typeof res.removeHeader === 'function') res.removeHeader('Content-Type');
    res.setHeader('Content-Length', '0');
    res.end();
  }
  return true;
}

/**
 * 发送 JSON 响应。
 * @param {object} res 响应对象
 * @param {number} statusCode HTTP 状态码
 * @param {object} payload 任意可序列化对象
 */
function sendJson(res, statusCode, payload) {
  if (!res || typeof res.end !== 'function') return;
  setCors(res);
  if (res.writableEnded) return;

  let body;
  try {
    body = JSON.stringify(payload === undefined ? null : payload);
  } catch (error) {
    // 理论上不会发生（payload 都由本服务拼装），兜底避免二次崩溃。
    body = JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: '服务器内部错误。' });
    statusCode = 500;
  }

  try {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  } catch (error) {
    // 响应已经断开时调用 end 可能抛错，这里吞掉即可，不能再抛给 Serverless 运行时。
  }
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------

/** 构造「非法 JSON」的结构化结果。 */
function invalidJsonResult() {
  return {
    ok: false,
    status: 400,
    code: 'INVALID_JSON',
    message: '请求体不是合法的 JSON 对象。'
  };
}

/** 构造「请求体过大」的结构化结果。 */
function payloadTooLargeResult(maxBytes) {
  return {
    ok: false,
    status: 400,
    code: 'PAYLOAD_TOO_LARGE',
    message: `请求体超过 ${Math.floor(maxBytes / 1024)}KB 限制。`
  };
}

/**
 * 解析文本为 JSON 对象（顶层必须是对象，数组/数字/字符串一律视为非法请求体）。
 * @param {string} text 原始文本
 * @param {number} maxBytes 字节上限
 * @returns {{ok:true,value:object}|{ok:false,status:number,code:string,message:string}}
 */
function parseJsonText(text, maxBytes) {
  if (typeof text !== 'string') return invalidJsonResult();

  // 去掉可能存在的 UTF-8 BOM，再用字节数复核大小，防止多字节字符绕过长度判断。
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return invalidJsonResult();
  if (Buffer.byteLength(cleaned, 'utf8') > maxBytes) return payloadTooLargeResult(maxBytes);

  let value;
  try {
    value = JSON.parse(cleaned);
  } catch (error) {
    return invalidJsonResult();
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidJsonResult();
  }
  return { ok: true, value };
}

/**
 * 读取并解析 JSON 请求体（上限默认 4KB）。
 *
 * 兼容三种运行场景：
 *  - Vercel 已经把 body 解析成对象；
 *  - body 是字符串或 Buffer；
 *  - 需要从可读流里手动收集（本地 node server / 单测）。
 *
 * @param {object} req 请求对象
 * @param {number} [maxBytes] 字节上限
 * @returns {Promise<{ok:true,value:object}|{ok:false,status:number,code:string,message:string}>}
 */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BODY_BYTES;
  const preParsed = req ? req.body : undefined;

  // 场景一：Vercel 已经解析过 body。
  if (preParsed !== undefined && preParsed !== null) {
    if (Buffer.isBuffer(preParsed)) {
      return Promise.resolve(parseJsonText(preParsed.toString('utf8'), limit));
    }
    if (typeof preParsed === 'string') {
      return Promise.resolve(parseJsonText(preParsed, limit));
    }
    if (typeof preParsed === 'object') {
      let serialized;
      try {
        serialized = JSON.stringify(preParsed);
      } catch (error) {
        return Promise.resolve(invalidJsonResult());
      }
      if (Buffer.byteLength(serialized, 'utf8') > limit) {
        return Promise.resolve(payloadTooLargeResult(limit));
      }
      return Promise.resolve({ ok: true, value: preParsed });
    }
    // number / boolean 等 JSON 标量：请求体必须为对象。
    return Promise.resolve(invalidJsonResult());
  }

  // 场景二：手动从流里读取。
  return new Promise((resolve) => {
    if (!req || typeof req.on !== 'function') {
      resolve(invalidJsonResult());
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onData = (chunk) => {
      if (settled) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const length = buffer && typeof buffer.length === 'number' ? buffer.length : 0;
      size += length;
      if (size > limit) {
        // 超限后不再缓存，把流排空即可；不改动连接状态，避免客户端看到网络错误。
        settle(payloadTooLargeResult(limit));
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      settle(parseJsonText(Buffer.concat(chunks).toString('utf8'), limit));
    };

    const onError = () => settle(invalidJsonResult());
    const onAborted = () => settle(invalidJsonResult());
    const onClose = () => {
      // close 在正常 end 之后也会触发，只有「还没收到 end」时才算异常。
      if (!settled && !req.readableEnded) settle(invalidJsonResult());
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// 超时与错误工具
// ---------------------------------------------------------------------------

/**
 * 给 Promise 增加超时。超时会以一个 code='SUPABASE_TIMEOUT' 的错误 reject。
 * @template T
 * @param {Promise<T>} promise 待执行的 Promise
 * @param {number} ms 超时毫秒数
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  const timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : SUPABASE_TIMEOUT_MS;
  let timer = null;

  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Supabase 请求超时');
      error.code = 'SUPABASE_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 判断是否为超时错误。
 * @param {unknown} error
 * @returns {boolean}
 */
function isTimeoutError(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 'SUPABASE_TIMEOUT';
}

/**
 * 提取「可安全写入日志」的错误信息：只保留 code 和截断后的 message。
 * 不上报堆栈、不上报请求体、不上报任何密钥。
 * @param {unknown} error
 * @returns {{code:string,message:string}}
 */
function safeErrorInfo(error) {
  if (!error || typeof error !== 'object') {
    return { code: 'UNKNOWN', message: '无错误详情' };
  }
  const code = typeof error.code === 'string' && error.code ? error.code : 'UNKNOWN';
  const rawMessage = typeof error.message === 'string' ? error.message : '';
  // 压成单行并截断，避免把多行堆栈 / require 调用链原样写进日志。
  const message = rawMessage ? rawMessage.replace(/\s+/g, ' ').slice(0, 300) : '无错误详情';
  return { code, message };
}

module.exports = {
  CORS_HEADERS,
  MAX_BODY_BYTES,
  SUPABASE_TIMEOUT_MS,
  setCors,
  handlePreflight,
  sendJson,
  readJsonBody,
  withTimeout,
  isTimeoutError,
  safeErrorInfo
};
