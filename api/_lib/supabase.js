'use strict';

/**
 * api/_lib/supabase.js
 * Supabase 客户端「懒加载单例」。
 *
 * 为什么懒加载：
 *  - Serverless 冷启动时如果没配环境变量，模块加载阶段不应该直接抛错，否则函数会以
 *    「运行时崩溃」的形式返回 HTML/纯文本 500，客户端拿不到结构化 JSON；
 *  - 把「创建客户端」推迟到 handler 真正需要数据库的时刻，错误就能被 try/catch 捕获，
 *    统一转换成 500 CONFIG_MISSING。
 *
 * 安全约定：
 *  - 只读取 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY；
 *  - service_role key 拥有绕过 RLS 的最高权限，绝对不能在日志或响应中出现；
 *  - 本文件不会打印任何环境变量的值。
 */

// 从 http 模块取超时常量，保持全后端一致（本文件不直接做超时，超时由 handler 统一包裹）。
const { SUPABASE_TIMEOUT_MS } = require('./http');

/** 单例缓存。 */
let supabaseClient = null;

/**
 * 缺少 / 非法环境变量时抛出的结构化错误。
 * handler 通过 error.code === 'CONFIG_MISSING' 识别并转成 500 JSON。
 */
class ConfigMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigMissingError';
    this.code = 'CONFIG_MISSING';
    this.status = 500;
  }
}

/**
 * 读取并清理环境变量（去首尾空白，非字符串视为空）。
 * @param {string} name 环境变量名
 * @returns {string}
 */
function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * 校验 SUPABASE_URL 是否像样，避免把错误配置直接传给 SDK。
 * @param {string} url
 * @returns {boolean}
 */
function isValidSupabaseUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (error) {
    return false;
  }
}

/**
 * 获取 Supabase 客户端单例（首次调用时才创建）。
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 * @throws {ConfigMissingError} 环境变量缺失或非法
 */
function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = readEnv('SUPABASE_URL');
  const serviceRoleKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !serviceRoleKey) {
    throw new ConfigMissingError('服务端缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 环境变量。');
  }
  if (!isValidSupabaseUrl(url)) {
    throw new ConfigMissingError('SUPABASE_URL 不是合法的 HTTP(S) 地址。');
  }

  // 延迟到真正需要时才 require：即使本地没安装依赖，缺 env 的请求也能稳定返回 JSON。
  const { createClient } = require('@supabase/supabase-js');

  supabaseClient = createClient(url, serviceRoleKey, {
    auth: {
      // 后端服务不需要维持用户会话，关掉一切会话持久化，避免无谓的本地状态。
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        // 方便在 Supabase 日志里识别来源，不含任何密钥。
        'x-application-name': 'bigfatfish-riceeater'
      }
    }
  });

  return supabaseClient;
}

/**
 * 重置单例（仅用于本地测试或密钥轮换后的热更新场景）。
 */
function resetSupabaseClient() {
  supabaseClient = null;
}

module.exports = {
  ConfigMissingError,
  SUPABASE_TIMEOUT_MS,
  getSupabaseClient,
  resetSupabaseClient
};
