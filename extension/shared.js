/**
 * 大肥鱼的白饭日记 · 共享核心逻辑
 * ------------------------------------------------------------------
 * 这个文件同时运行在两个完全不同的环境里：
 *   1. Popup 页面（有 DOM，可以 import 脚本）
 *   2. MV3 Service Worker（没有 DOM，只能用 importScripts）
 * 因此这里只允许使用：chrome.storage.local、fetch、crypto、标准 JS。
 * 绝对不要在这里碰 document / window 上的 UI 能力。
 *
 * 另外为了可测试性，本文件不依赖任何打包工具，挂载到 globalThis.BFF 上。
 */
(function (root) {
  'use strict';

  /* ================================================================
   * 一、常量与成就目录
   * ================================================================ */

  const VERSION = '1.0.0';

  /** 1 元 = 10 碗白饭（也就是 0.1 元 / 碗） */
  const RICE_PER_YUAN = 10;
  const PRICE_PER_BOWL = 0.1;

  /** DeepSeek 官方余额查询接口 */
  const BALANCE_URL = 'https://api.deepseek.com/user/balance';

  /** chrome.storage.local 使用的 key，集中管理避免拼错 */
  const STORAGE_KEYS = Object.freeze({
    settings: 'bff_settings',
    state: 'bff_state',
    achievements: 'bff_achievements',
    rankCache: 'bff_rank_cache'
  });

  /** 默认设置：apiBase 是示例部署地址，用户可以在设置里改成自己的 Vercel 域名 */
  const DEFAULT_SETTINGS = Object.freeze({
    apiKey: '',
    nickname: '匿名肥鱼',
    syncEnabled: true,
    refreshMinutes: 30,
    apiBase: 'https://bigfatfish-riceeater.vercel.app'
  });

  /** 网络超时（毫秒） */
  const REQUEST_TIMEOUT = 12000;
  /** 两次排行榜同步之间的最小间隔（毫秒） */
  const SYNC_MIN_INTERVAL = 15000;
  /** 被防作弊拦截后的冷却时间：5 分钟 */
  const SYNC_REJECT_COOLDOWN = 5 * 60 * 1000;
  /** 同步失败后的重试冷却时间：1 分钟 */
  const SYNC_ERROR_COOLDOWN = 60 * 1000;
  /** 待展示 Toast 的最大堆叠数量 */
  const MAX_PENDING_TOASTS = 20;

  /** 昵称最大长度（按 Unicode 字符计） */
  const NICKNAME_MAX_LENGTH = 20;

  /**
   * 全部 16 个成就。
   * check 是内部判定函数，不参与存储；ACHIEVEMENTS 对外暴露时会保留该字段，
   * UI 只读取 id / group / name / emoji / condition / desc。
   */
  const ACHIEVEMENTS = [
    /* ---------------- 财富阶级系列：按累计白饭数 ---------------- */
    {
      id: 'wealth_rookie',
      group: 'wealth',
      emoji: '🥣',
      name: '讨饭萌新',
      condition: '累计干饭 1 碗',
      desc: '大肥鱼探出了头，小心翼翼地尝了一口。',
      threshold: 1,
      check: function (state) {
        return state.totalRice >= 1;
      }
    },
    {
      id: 'wealth_killer',
      group: 'wealth',
      emoji: '🥢',
      name: '白饭杀手',
      condition: '累计干饭 50 碗',
      desc: '平平淡淡才是真，白饭管饱就行。',
      threshold: 50,
      check: function (state) {
        return state.totalRice >= 50;
      }
    },
    {
      id: 'wealth_chicken',
      group: 'wealth',
      emoji: '🍱',
      name: '加个鸡腿',
      condition: '累计干饭 200 碗',
      desc: '光吃白饭太干了，给自己加个鸡腿吧！',
      threshold: 200,
      check: function (state) {
        return state.totalRice >= 200;
      }
    },
    {
      id: 'wealth_feast',
      group: 'wealth',
      emoji: '🍲',
      name: '满汉全席',
      condition: '累计干饭 1000 碗',
      desc: '大肥鱼已经进化成了大肥猪，吃穿不愁。',
      threshold: 1000,
      check: function (state) {
        return state.totalRice >= 1000;
      }
    },
    {
      id: 'wealth_bucket',
      group: 'wealth',
      emoji: '👑',
      name: '赛博饭桶',
      condition: '累计干饭 5000 碗',
      desc: '老板，再来一桶！这鱼疯了！',
      threshold: 5000,
      check: function (state) {
        return state.totalRice >= 5000;
      }
    },
    {
      id: 'wealth_blackhole',
      group: 'wealth',
      emoji: '🌌',
      name: '黑洞吞噬者',
      condition: '累计干饭 10000 碗',
      desc: '连光都无法逃离大肥鱼的胃。',
      threshold: 10000,
      check: function (state) {
        return state.totalRice >= 10000;
      }
    },

    /* ---------------- 连吃天数系列 ---------------- */
    {
      id: 'streak_three',
      group: 'streak',
      emoji: '🌱',
      name: '一日三餐',
      condition: '连续干饭 3 天',
      desc: '大肥鱼学会了定点进食。',
      threshold: 3,
      check: function (state) {
        return state.streakDays >= 3;
      }
    },
    {
      id: 'streak_seven',
      group: 'streak',
      emoji: '🔥',
      name: '干饭劳模',
      condition: '连续干饭 7 天',
      desc: '风雨无阻，哪怕报错也要吃白饭。',
      threshold: 7,
      check: function (state) {
        return state.streakDays >= 7;
      }
    },
    {
      id: 'streak_thirty',
      group: 'streak',
      emoji: '⏳',
      name: '海枯石烂',
      condition: '连续干饭 30 天',
      desc: '这鱼是把工位搬到食堂了吗？',
      threshold: 30,
      check: function (state) {
        return state.streakDays >= 30;
      }
    },

    /* ---------------- 特殊事件系列 ---------------- */
    {
      id: 'special_near_death',
      group: 'special',
      emoji: '💸',
      name: '濒死体验',
      condition: '余额低于 1 元',
      desc: '大肥鱼饿得翻白眼了，快充值！',
      check: function (state) {
        return state.balance !== null && Number.isFinite(state.balance) && state.balance < 1;
      }
    },
    {
      id: 'special_hibernation',
      group: 'special',
      emoji: '🛌',
      name: '吃饱就睡',
      condition: '连续 3 天没吃上饭',
      desc: '大肥鱼进入了冬眠。',
      check: function (state, ctx) {
        if (!state.lastEatDate) return false;
        const days = daysBetween(state.lastEatDate, dateKey(ctx.now));
        return days !== null && days >= 3;
      }
    },
    {
      id: 'special_binge',
      group: 'special',
      emoji: '🌪️',
      name: '暴饮暴食',
      condition: '单次刷新消耗超过 10 元',
      desc: '一口气吃下 100 碗！你拿我当牛使呢？',
      check: function (state) {
        return state.maxSingleSpend > 10;
      }
    },
    {
      id: 'special_diet',
      group: 'special',
      emoji: '📉',
      name: '赛博减肥',
      condition: '余额神秘增加（退款/退订）',
      desc: '吃进去的白饭还能吐出来？医学奇迹！',
      check: function (state) {
        return state.balanceIncreaseCount >= 1;
      }
    },

    /* ---------------- 排行榜互动系列 ---------------- */
    {
      id: 'rank_fry',
      group: 'rank',
      emoji: '🐟',
      name: '鱼苗',
      condition: '参与匿名排行榜',
      desc: '饭桶里的一粒米。',
      check: function (state, ctx) {
        return !!(ctx.joinedRank || state.joinedRank);
      }
    },
    {
      id: 'rank_whale',
      group: 'rank',
      emoji: '🐳',
      name: '深海巨物',
      condition: '冲进榜单前三',
      desc: '让一让，大肥鱼来清场了。',
      check: function (state, ctx) {
        if (ctx.rank !== null && Number.isFinite(ctx.rank) && ctx.rank <= 3) return true;
        return state.rankBest !== null && Number.isFinite(state.rankBest) && state.rankBest <= 3;
      }
    },
    {
      id: 'rank_king',
      group: 'rank',
      emoji: '🏆',
      name: '鱼王',
      condition: '登顶榜单第一',
      desc: '整个服务器的白饭，由我一人承包！',
      check: function (state, ctx) {
        if (ctx.rank === 1) return true;
        return state.rankIsFirst === true;
      }
    }
  ];

  /* ================================================================
   * 二、基础工具函数
   * ================================================================ */

  /** 四舍五入到 1 位小数（白饭碗数） */
  function round1(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const result = Math.round((n + Number.EPSILON) * 10) / 10;
    return Object.is(result, -0) ? 0 : result;
  }

  /** 四舍五入到 2 位小数（人民币金额） */
  function round2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const result = Math.round((n + Number.EPSILON) * 100) / 100;
    return Object.is(result, -0) ? 0 : result;
  }

  /** 数字安全转换，非法值返回 fallback */
  function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** 把数字限制在 [min, max] 内 */
  function clamp(value, min, max) {
    const n = toNumber(value, min);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /** 补零，例如 3 -> '03' */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * 生成本地时区的日期字符串 YYYY-MM-DD。
   * 注意：不能用 toISOString()，那是 UTC，会让东八区的用户「跨天」错位。
   */
  function dateKey(timestamp) {
    const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 把 YYYY-MM-DD 解析为 UTC 零点时间戳，仅用于计算日期差 */
  function parseDateKey(key) {
    if (typeof key !== 'string') return null;
    const parts = key.split('-');
    if (parts.length !== 3) return null;
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(year, month - 1, day);
  }

  /**
   * 计算两个日期字符串相差的天数（to - from）。
   * 例如 from='2026-11-01'、to='2026-11-04' 返回 3。
   */
  function daysBetween(fromKey, toKey) {
    const from = parseDateKey(fromKey);
    const to = parseDateKey(toKey);
    if (from === null || to === null) return null;
    return Math.round((to - from) / 86400000);
  }

  /** 格式化白饭碗数：12 -> '12'，12.5 -> '12.5'，0 -> '0' */
  function formatRice(value) {
    const n = round1(value);
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1);
  }

  /** 格式化金额：110 -> '110.00' */
  function formatYuan(value) {
    const n = round2(value);
    return n.toFixed(2);
  }

  /** 元 -> 碗 */
  function yuanToRice(yuan) {
    return round1(toNumber(yuan, 0) * RICE_PER_YUAN);
  }

  /** 碗 -> 元 */
  function riceToYuan(rice) {
    return round2(toNumber(rice, 0) * PRICE_PER_BOWL);
  }

  /**
   * 清洗昵称：
   *  - 去掉控制字符（防止把排行榜/弹窗搞崩）
   *  - 去掉首尾空白
   *  - 按 Unicode 字符截断到 20 个
   *  - 空昵称回落到「匿名肥鱼」
   */
  function normalizeNickname(raw) {
    let text = typeof raw === 'string' ? raw : '';
    text = text.replace(/[\u0000-\u001F\u007F]/g, '');
    text = text.trim();
    const chars = Array.from(text);
    if (chars.length > NICKNAME_MAX_LENGTH) {
      text = chars.slice(0, NICKNAME_MAX_LENGTH).join('');
    }
    return text || DEFAULT_SETTINGS.nickname;
  }

  /**
   * 归一化后端地址：
   *  - 去掉尾部斜杠
   *  - 必须是 http/https，否则回落到默认地址
   *  - 去掉多余的 query / hash
   */
  function normalizeApiBase(raw) {
    let text = typeof raw === 'string' ? raw.trim() : '';
    text = text.replace(/\/+$/, '');
    if (!text) return DEFAULT_SETTINGS.apiBase;
    try {
      const url = new URL(text);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return DEFAULT_SETTINGS.apiBase;
      }
      return (url.origin + url.pathname).replace(/\/+$/, '');
    } catch (err) {
      return DEFAULT_SETTINGS.apiBase;
    }
  }

  /** 归一化设置对象 */
  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
      nickname: normalizeNickname(source.nickname),
      syncEnabled: source.syncEnabled !== false,
      refreshMinutes: Math.round(clamp(source.refreshMinutes, 15, 720)),
      apiBase: normalizeApiBase(source.apiBase)
    };
  }

  /** 生成 UUID v4；优先用 crypto.randomUUID，老环境用 getRandomValues 兜底 */
  function generateDeviceId() {
    try {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        return root.crypto.randomUUID();
      }
    } catch (err) {
      /* 某些环境会禁用随机数，忽略并走兜底逻辑 */
    }
    try {
      if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        root.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.prototype.map
          .call(bytes, function (b) {
            return b.toString(16).padStart(2, '0');
          })
          .join('');
        return (
          hex.slice(0, 8) +
          '-' +
          hex.slice(8, 12) +
          '-' +
          hex.slice(12, 16) +
          '-' +
          hex.slice(16, 20) +
          '-' +
          hex.slice(20)
        );
      }
    } catch (err) {
      /* 继续走最终兜底 */
    }
    // 最终兜底：时间戳 + 随机数（仅用于开发环境，正常浏览器不会走到这里）
    return (
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      })
    );
  }

  /** 校验 UUID 格式（与后端保持一致） */
  function isUuid(value) {
    if (typeof value !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  /* ================================================================
   * 三、chrome.storage.local 封装
   * ================================================================ */

  /** 判断当前环境是否有可用的 chrome.storage.local */
  function hasStorage() {
    return !!(root.chrome && root.chrome.storage && root.chrome.storage.local);
  }

  /**
   * 同时兼容 Promise 版与回调版 chrome.storage API。
   * 新版 Chrome 返回 Promise，老版本调用回调；这里两个都接，谁先到用谁。
   */
  function callStorage(method, argument) {
    return new Promise(function (resolve, reject) {
      if (!hasStorage()) {
        // 没有存储能力时返回空对象，让页面至少能渲染默认状态
        resolve(method === 'get' ? {} : undefined);
        return;
      }
      let settled = false;
      function done(result) {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      }
      function fail(error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
      try {
        const maybePromise = root.chrome.storage.local[method](argument, function (result) {
          const lastError = root.chrome.runtime && root.chrome.runtime.lastError;
          if (lastError) {
            fail(new Error(lastError.message || 'chrome.storage 读写失败'));
          } else {
            done(result);
          }
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(done, fail);
        }
      } catch (err) {
        fail(err);
      }
    });
  }

  /** 读取 storage 中的若干 key */
  async function storageGet(keys) {
    const result = await callStorage('get', keys);
    return result && typeof result === 'object' ? result : {};
  }

  /**
   * 写入队列：把并发写串行化，避免「后台定时刷新」和「Popup 手动刷新」
   * 同时写 state 时互相覆盖（虽然不能完全替代 CAS，但能消除大部分竞态）。
   */
  let writeQueue = Promise.resolve();

  function enqueueWrite(task) {
    const running = writeQueue.then(task, task);
    // 队列自身吞掉错误，避免一次失败让后续写入全部中断
    writeQueue = running.then(
      function () {
        return undefined;
      },
      function () {
        return undefined;
      }
    );
    return running;
  }

  /** 写 storage（串行） */
  function storageSet(items) {
    return enqueueWrite(function () {
      return callStorage('set', items);
    });
  }

  /** 移除 storage key（串行） */
  function storageRemove(keys) {
    return enqueueWrite(function () {
      return callStorage('remove', keys);
    });
  }

  /** 读取并归一化设置 */
  async function loadSettings() {
    const items = await storageGet(STORAGE_KEYS.settings);
    return normalizeSettings(items[STORAGE_KEYS.settings]);
  }

  /** 合并写入设置，返回写入后的完整设置 */
  async function saveSettings(patch) {
    const current = await loadSettings();
    const merged = Object.assign({}, current, patch && typeof patch === 'object' ? patch : {});
    const normalized = normalizeSettings(merged);
    await storageSet({ [STORAGE_KEYS.settings]: normalized });
    return normalized;
  }

  /** 生成默认 state */
  function createDefaultState(now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return {
      deviceId: generateDeviceId(),
      balance: null,
      totalSpent: 0,
      totalRice: 0,
      todayDate: dateKey(ts),
      todayRice: 0,
      streakDays: 0,
      lastEatDate: '',
      lastEatAt: 0,
      maxSingleSpend: 0,
      balanceIncreaseCount: 0,
      lastCheckAt: 0,
      lastCheckStatus: 'idle',
      lastError: null,
      baselineAt: 0,
      joinedRank: false,
      rankBest: null,
      rankIsFirst: false,
      lastSyncAt: 0,
      lastSyncedRice: 0,
      lastSyncStatus: 'idle',
      lastSyncError: null,
      syncCooldownUntil: 0,
      pendingToasts: [],
      firstRunAt: ts
    };
  }

  /**
   * 归一化 state：
   *  - 补齐所有默认字段（升级版本时不会因为缺字段爆炸）
   *  - 修正非法数字
   *  - 跨天时把今日白饭归零
   *  - deviceId 缺失/非法时重新生成
   */
  function normalizeState(raw, now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const defaults = createDefaultState(ts);
    const source = raw && typeof raw === 'object' ? raw : {};
    const state = Object.assign({}, defaults, source);

    state.deviceId = isUuid(source.deviceId) ? source.deviceId : generateDeviceId();
    state.balance =
      source.balance === null || source.balance === undefined || source.balance === ''
        ? null
        : round2(source.balance);
    state.totalSpent = Math.max(0, round2(source.totalSpent));
    state.totalRice = Math.max(0, round1(source.totalRice));
    state.todayRice = Math.max(0, round1(source.todayRice));
    state.streakDays = Math.max(0, Math.floor(toNumber(source.streakDays, 0)));
    state.maxSingleSpend = Math.max(0, round2(source.maxSingleSpend));
    state.balanceIncreaseCount = Math.max(0, Math.floor(toNumber(source.balanceIncreaseCount, 0)));
    state.lastCheckAt = Math.max(0, toNumber(source.lastCheckAt, 0));
    state.lastEatAt = Math.max(0, toNumber(source.lastEatAt, 0));
    state.baselineAt = Math.max(0, toNumber(source.baselineAt, 0));
    state.rankBest =
      source.rankBest === null || source.rankBest === undefined ? null : toNumber(source.rankBest, null);
    state.lastSyncAt = Math.max(0, toNumber(source.lastSyncAt, 0));
    state.lastSyncedRice = Math.max(0, round1(source.lastSyncedRice));
    state.syncCooldownUntil = Math.max(0, toNumber(source.syncCooldownUntil, 0));

    state.lastCheckStatus = ['idle', 'ok', 'error'].indexOf(source.lastCheckStatus) >= 0
      ? source.lastCheckStatus
      : 'idle';
    state.lastSyncStatus = ['idle', 'ok', 'rejected', 'error', 'throttled'].indexOf(source.lastSyncStatus) >= 0
      ? source.lastSyncStatus
      : 'idle';

    state.pendingToasts = Array.isArray(source.pendingToasts)
      ? source.pendingToasts
          .filter(function (item) {
            return item && typeof item === 'object' && typeof item.id === 'string';
          })
          .slice(-MAX_PENDING_TOASTS)
      : [];

    state.lastError =
      source.lastError && typeof source.lastError === 'object'
        ? {
            code: String(source.lastError.code || 'UNKNOWN'),
            message: String(source.lastError.message || '未知错误'),
            at: toNumber(source.lastError.at, 0)
          }
        : null;
    state.lastSyncError =
      source.lastSyncError && typeof source.lastSyncError === 'object'
        ? {
            code: String(source.lastSyncError.code || 'UNKNOWN'),
            message: String(source.lastSyncError.message || '未知错误'),
            at: toNumber(source.lastSyncError.at, 0)
          }
        : null;

    // 跨天重置：只归零「今日」计数，累计数据保持不动
    const today = dateKey(ts);
    if (state.todayDate !== today) {
      state.todayDate = today;
      state.todayRice = 0;
    }

    // 累计金额与累计碗数理论上应一致；以 totalSpent 为准做一次纠偏
    if (state.totalRice === 0 && state.totalSpent > 0) {
      state.totalRice = round1(state.totalSpent * RICE_PER_YUAN);
    }

    return state;
  }

  /** 读取 state；首次运行自动生成并落盘 deviceId */
  async function loadState(now) {
    const items = await storageGet(STORAGE_KEYS.state);
    const raw = items[STORAGE_KEYS.state];
    const state = normalizeState(raw, now);
    const needPersist = !raw || typeof raw !== 'object' || raw.deviceId !== state.deviceId;
    if (needPersist) {
      try {
        await storageSet({ [STORAGE_KEYS.state]: state });
      } catch (err) {
        // 存储失败不阻断 UI，下一次刷新会再试
      }
    }
    return state;
  }

  /** 写入 state */
  function saveState(state) {
    return storageSet({ [STORAGE_KEYS.state]: state });
  }

  /** 读取成就解锁表 */
  async function loadAchievements() {
    const items = await storageGet(STORAGE_KEYS.achievements);
    const raw = items[STORAGE_KEYS.achievements];
    if (!raw || typeof raw !== 'object') return {};
    const result = {};
    Object.keys(raw).forEach(function (id) {
      const item = raw[id];
      if (item && typeof item === 'object' && Number.isFinite(Number(item.unlockedAt))) {
        result[id] = { unlockedAt: Number(item.unlockedAt) };
      }
    });
    return result;
  }

  /** 写入成就解锁表 */
  function saveAchievements(achievements) {
    return storageSet({ [STORAGE_KEYS.achievements]: achievements || {} });
  }

  /** 读取本地缓存的排行榜 */
  async function loadRankCache() {
    const items = await storageGet(STORAGE_KEYS.rankCache);
    const raw = items[STORAGE_KEYS.rankCache];
    if (!raw || typeof raw !== 'object') return null;
    return {
      fetchedAt: toNumber(raw.fetchedAt, 0),
      ranks: Array.isArray(raw.ranks) ? raw.ranks : [],
      me: raw.me && typeof raw.me === 'object' ? raw.me : null
    };
  }

  /** 清空本地数据（设置 / 状态 / 成就 / 榜单缓存），用于「重新投胎」 */
  async function clearAllData() {
    await storageRemove([
      STORAGE_KEYS.settings,
      STORAGE_KEYS.state,
      STORAGE_KEYS.achievements,
      STORAGE_KEYS.rankCache
    ]);
  }

  /* ================================================================
   * 四、网络请求
   * ================================================================ */

  /**
   * 统一的 JSON 请求封装：
   *  - AbortController 超时
   *  - 先读文本再尝试 JSON.parse（避免空响应体直接抛错）
   *  - 返回 { response, data }，由调用方决定错误语义
   */
  async function requestJson(url, options, timeoutMs) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const settings = Object.assign({}, options || {});
    if (controller) {
      settings.signal = controller.signal;
      timer = setTimeout(function () {
        try {
          controller.abort();
        } catch (err) {
          /* 忽略 abort 异常 */
        }
      }, timeoutMs || REQUEST_TIMEOUT);
    }
    try {
      const response = await fetch(url, settings);
      let text = '';
      try {
        text = await response.text();
      } catch (err) {
        text = '';
      }
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (err) {
          data = null;
        }
      }
      return { response: response, data: data, text: text };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 判断异常是不是超时中断 */
  function isAbortError(error) {
    if (!error) return false;
    return error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.name === 'TimeoutError';
  }

  /**
   * 查询 DeepSeek 余额。
   * 成功：{ ok:true, totalBalance, currency, isAvailable, raw }
   * 失败：{ ok:false, code:'NO_KEY'|'AUTH'|'NETWORK'|'TIMEOUT'|'API'|'PARSE'|'HTTP', message, status? }
   */
  async function fetchBalance(apiKey) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) {
      return { ok: false, code: 'NO_KEY', message: '还没填写 DeepSeek API Key，大肥鱼饿着肚子呢。' };
    }
    try {
      const result = await requestJson(
        BALANCE_URL,
        {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + key,
            Accept: 'application/json'
          },
          cache: 'no-store'
        },
        REQUEST_TIMEOUT
      );
      const response = result.response;
      const data = result.data;

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: 'AUTH',
          status: response.status,
          message: 'API Key 无效、过期或没有权限（HTTP ' + response.status + '）。'
        };
      }
      if (response.status === 429) {
        return {
          ok: false,
          code: 'HTTP',
          status: 429,
          message: '请求太频繁，被 DeepSeek 限流了，过一会儿再试。'
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: 'HTTP',
          status: response.status,
          message: '余额接口返回 HTTP ' + response.status + '，请稍后再试。'
        };
      }
      if (!data || typeof data !== 'object') {
        return { ok: false, code: 'PARSE', message: '余额接口返回的不是合法 JSON。' };
      }

      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
      if (infos.length === 0) {
        return { ok: false, code: 'API', message: '余额接口没有返回任何余额信息（balance_infos 为空）。' };
      }
      const cnyInfo = infos.find(function (info) {
        return info && String(info.currency || '').toUpperCase() === 'CNY';
      });
      const chosen = cnyInfo || infos[0];
      const total = Number(chosen.total_balance);
      if (!Number.isFinite(total)) {
        return { ok: false, code: 'API', message: '余额字段 total_balance 无法解析。' };
      }
      return {
        ok: true,
        totalBalance: round2(total),
        currency: String(chosen.currency || 'CNY').toUpperCase(),
        isAvailable: data.is_available !== false,
        raw: data
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          code: 'TIMEOUT',
          message: '请求 DeepSeek 余额超时（' + Math.round(REQUEST_TIMEOUT / 1000) + ' 秒），检查一下网络吧。'
        };
      }
      return {
        ok: false,
        code: 'NETWORK',
        message: '网络请求失败：' + (error && error.message ? error.message : '未知网络错误')
      };
    }
  }

  /**
   * 上报排行榜。
   * 成功：{ ok:true, rank, totalRice }
   * 被拒：{ ok:false, rejected:true, code, message, retryAfterSeconds }
   * 失败：{ ok:false, rejected:false, code, message }
   */
  async function syncRank(options) {
    const opts = options || {};
    const deviceId = typeof opts.deviceId === 'string' ? opts.deviceId : '';
    if (!isUuid(deviceId)) {
      return { ok: false, rejected: false, code: 'NO_DEVICE', message: '设备 ID 不合法，无法上报排行榜。' };
    }
    const base = normalizeApiBase(opts.apiBase);
    const body = {
      deviceId: deviceId,
      nickname: normalizeNickname(opts.nickname),
      totalRice: round1(opts.totalRice)
    };
    try {
      const result = await requestJson(
        base + '/api/rank/update',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store'
        },
        REQUEST_TIMEOUT
      );
      const response = result.response;
      const data = result.data;

      if (response.status === 405) {
        return { ok: false, rejected: false, code: 'HTTP', message: '排行榜接口不支持该请求方式（HTTP 405）。' };
      }
      if (!response.ok) {
        return {
          ok: false,
          rejected: false,
          code: 'HTTP',
          status: response.status,
          message: '排行榜服务返回 HTTP ' + response.status + '，可能还没部署后端。'
        };
      }
      if (!data || typeof data !== 'object') {
        return { ok: false, rejected: false, code: 'PARSE', message: '排行榜服务返回的不是合法 JSON。' };
      }
      if (data.rejected === true || data.ok === false) {
        return {
          ok: false,
          rejected: true,
          code: String(data.reason || 'REJECTED'),
          message: String(data.message || '这次成绩被防作弊系统没收了。'),
          retryAfterSeconds: Number.isFinite(Number(data.retryAfterSeconds))
            ? Number(data.retryAfterSeconds)
            : 0
        };
      }
      const rank = Number(data.rank);
      if (!Number.isFinite(rank) || rank < 1) {
        return { ok: false, rejected: false, code: 'PARSE', message: '排行榜服务没有返回有效名次。' };
      }
      return {
        ok: true,
        rank: Math.floor(rank),
        totalRice: round1(data.totalRice !== undefined ? data.totalRice : body.totalRice)
      };
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, rejected: false, code: 'TIMEOUT', message: '上报排行榜超时，稍后再试。' };
      }
      return {
        ok: false,
        rejected: false,
        code: 'NETWORK',
        message: '上报排行榜失败：' + (error && error.message ? error.message : '网络错误')
      };
    }
  }

  /** 把服务端返回的榜单清洗成固定结构，顺便防一手脏数据 */
  function sanitizeRanks(rawList) {
    if (!Array.isArray(rawList)) return [];
    const result = [];
    rawList.forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      const rank = Number(item.rank);
      const totalRice = Number(item.totalRice);
      result.push({
        rank: Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : index + 1,
        nickname: normalizeNickname(item.nickname),
        totalRice: Number.isFinite(totalRice) ? round1(totalRice) : 0
      });
    });
    return result;
  }

  /** 清洗「我的排名」 */
  function sanitizeMe(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rank = Number(raw.rank);
    const totalRice = Number(raw.totalRice);
    if (!Number.isFinite(rank) || rank < 1) return null;
    return {
      rank: Math.floor(rank),
      nickname: normalizeNickname(raw.nickname),
      totalRice: Number.isFinite(totalRice) ? round1(totalRice) : 0
    };
  }

  /**
   * 拉取排行榜 Top N。
   * 成功：{ ok:true, ranks, me, fetchedAt }
   */
  async function fetchTop(options) {
    const opts = options || {};
    const base = normalizeApiBase(opts.apiBase);
    const limit = Math.floor(clamp(opts.limit, 1, 100));
    let url = base + '/api/rank/top?limit=' + limit;
    if (isUuid(opts.deviceId)) {
      url += '&deviceId=' + encodeURIComponent(opts.deviceId);
    }
    try {
      const result = await requestJson(
        url,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        },
        REQUEST_TIMEOUT
      );
      const response = result.response;
      const data = result.data;

      if (!response.ok) {
        return {
          ok: false,
          code: 'HTTP',
          status: response.status,
          message: '榜单服务返回 HTTP ' + response.status + '。'
        };
      }
      if (!data || typeof data !== 'object') {
        return { ok: false, code: 'PARSE', message: '榜单服务返回的不是合法 JSON。' };
      }
      return {
        ok: true,
        ranks: sanitizeRanks(data.ranks),
        me: sanitizeMe(data.me),
        fetchedAt: Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : Date.now()
      };
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, code: 'TIMEOUT', message: '拉取榜单超时，鱼网卡住了。' };
      }
      return {
        ok: false,
        code: 'NETWORK',
        message: '拉取榜单失败：' + (error && error.message ? error.message : '网络错误')
      };
    }
  }

  /** 拉取榜单并写入本地缓存 */
  async function refreshRank(options) {
    const result = await fetchTop(options);
    if (result.ok) {
      try {
        await storageSet({
          [STORAGE_KEYS.rankCache]: {
            fetchedAt: result.fetchedAt,
            ranks: result.ranks,
            me: result.me
          }
        });
      } catch (err) {
        // 缓存失败不影响本次展示
      }
    }
    return result;
  }

  /* ================================================================
   * 五、核心业务逻辑
   * ================================================================ */

  /**
   * 把一次余额查询的结果应用到 state 上。
   * 纯函数：不读写 storage，不产生副作用，方便单元测试。
   *
   * @returns {{state:object, spent:number, riceGained:number, event:string}}
   */
  function applyBalance(state, balanceInfo, now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const next = Object.assign({}, state);
    next.pendingToasts = Array.isArray(state.pendingToasts) ? state.pendingToasts.slice() : [];

    const today = dateKey(ts);
    if (next.todayDate !== today) {
      next.todayDate = today;
      next.todayRice = 0;
    }

    const info = balanceInfo && typeof balanceInfo === 'object' ? balanceInfo : {};
    const newBalance = round2(Number(info.totalBalance));
    if (!Number.isFinite(newBalance)) {
      throw new Error('余额数据不合法，无法换算白饭。');
    }

    let spent = 0;
    let riceGained = 0;
    let event = 'none';

    if (next.balance === null || next.balance === undefined || !Number.isFinite(Number(next.balance))) {
      // 首次记录：只当基准，不算消耗，避免一上来就白嫖一个成就
      next.balance = newBalance;
      next.baselineAt = next.baselineAt || ts;
      event = 'baseline';
    } else {
      const prevBalance = round2(Number(next.balance));
      const delta = round2(prevBalance - newBalance);

      if (delta > 0.004) {
        // 余额减少 = 干了饭
        spent = delta;
        riceGained = round1(delta * RICE_PER_YUAN);
        next.totalSpent = round2(toNumber(next.totalSpent, 0) + delta);
        next.totalRice = round1(next.totalSpent * RICE_PER_YUAN);
        next.todayRice = round1(toNumber(next.todayRice, 0) + riceGained);
        next.maxSingleSpend = Math.max(round2(next.maxSingleSpend), spent);

        const lastEatDate = next.lastEatDate;
        if (lastEatDate === today) {
          // 今天已经吃过，连续天数保持，但至少是 1
          if (!next.streakDays || next.streakDays < 1) next.streakDays = 1;
        } else if (lastEatDate && daysBetween(lastEatDate, today) === 1) {
          // 昨天也吃了，连续 +1
          next.streakDays = Math.max(1, Math.floor(toNumber(next.streakDays, 0))) + 1;
        } else {
          // 断签（或第一次），从 1 开始
          next.streakDays = 1;
        }
        next.lastEatDate = today;
        next.lastEatAt = ts;
        event = 'spend';
      } else if (delta < -0.004) {
        // 余额增加 = 退款/退订，白饭不会吐出来，但可以解锁「赛博减肥」
        next.balanceIncreaseCount = Math.floor(toNumber(next.balanceIncreaseCount, 0)) + 1;
        event = 'refund';
      }

      next.balance = newBalance;
    }

    next.lastCheckAt = ts;
    return { state: next, spent: spent, riceGained: riceGained, event: event };
  }

  /**
   * 成就判定：遍历全部成就，返回新的解锁表和本次新解锁列表。
   * 纯函数，不读写 storage。
   *
   * ctx: { now, rank, joinedRank }
   */
  function evaluateAchievements(state, achievements, ctx) {
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    const now = Number.isFinite(Number(context.now)) ? Number(context.now) : Date.now();
    const rankValue = context.rank === null || context.rank === undefined ? null : Number(context.rank);
    const evalCtx = {
      now: now,
      rank: Number.isFinite(rankValue) ? rankValue : null,
      joinedRank: !!context.joinedRank
    };

    const unlockedMap = Object.assign({}, achievements && typeof achievements === 'object' ? achievements : {});
    const newlyUnlocked = [];

    ACHIEVEMENTS.forEach(function (achievement) {
      if (unlockedMap[achievement.id]) return;
      let hit = false;
      try {
        hit = !!achievement.check(state, evalCtx);
      } catch (err) {
        // 单个成就判定异常不应该拖垮整个刷新流程
        hit = false;
      }
      if (hit) {
        unlockedMap[achievement.id] = { unlockedAt: now };
        newlyUnlocked.push({
          id: achievement.id,
          group: achievement.group,
          name: achievement.name,
          emoji: achievement.emoji,
          condition: achievement.condition,
          desc: achievement.desc,
          unlockedAt: now
        });
      }
    });

    return { achievements: unlockedMap, newlyUnlocked: newlyUnlocked };
  }

  /** 把新解锁的成就追加进待展示队列（去重、限长） */
  function appendToasts(existing, newlyUnlocked) {
    const list = Array.isArray(existing) ? existing.slice() : [];
    const seen = {};
    list.forEach(function (item) {
      if (item && item.id) seen[item.id] = true;
    });
    (newlyUnlocked || []).forEach(function (item) {
      if (!item || !item.id || seen[item.id]) return;
      seen[item.id] = true;
      list.push({
        id: item.id,
        name: item.name,
        emoji: item.emoji,
        desc: item.desc,
        unlockedAt: item.unlockedAt || Date.now()
      });
    });
    return list.slice(-MAX_PENDING_TOASTS);
  }

  /**
   * 把一次同步结果写进 state。
   * 纯函数，返回新的 state。
   */
  function recordSyncResult(state, syncResult, now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const next = Object.assign({}, state);
    const result = syncResult || {};

    if (result.ok) {
      next.joinedRank = true;
      const rank = Number(result.rank);
      if (Number.isFinite(rank) && rank > 0) {
        const normalizedRank = Math.floor(rank);
        next.rankBest =
          next.rankBest === null || next.rankBest === undefined
            ? normalizedRank
            : Math.min(Number(next.rankBest), normalizedRank);
        if (normalizedRank === 1) next.rankIsFirst = true;
      }
      next.lastSyncStatus = 'ok';
      next.lastSyncError = null;
      next.lastSyncAt = ts;
      next.lastSyncedRice = round1(result.totalRice !== undefined ? result.totalRice : next.totalRice);
      next.syncCooldownUntil = 0;
      return next;
    }

    if (result.rejected) {
      next.lastSyncStatus = 'rejected';
      next.lastSyncError = {
        code: String(result.code || 'REJECTED'),
        message: String(result.message || '防作弊系统把这次成绩没收了。'),
        at: ts
      };
      next.lastSyncAt = ts;
      next.syncCooldownUntil = ts + SYNC_REJECT_COOLDOWN;
      return next;
    }

    next.lastSyncStatus = 'error';
    next.lastSyncError = {
      code: String(result.code || 'SYNC_ERROR'),
      message: String(result.message || '排行榜同步失败。'),
      at: ts
    };
    next.lastSyncAt = ts;
    next.syncCooldownUntil = ts + SYNC_ERROR_COOLDOWN;
    return next;
  }

  /** 读走待展示的成就 Toast，并清空队列 */
  async function consumePendingToasts() {
    const state = await loadState();
    const toasts = Array.isArray(state.pendingToasts) ? state.pendingToasts.slice() : [];
    if (toasts.length > 0) {
      state.pendingToasts = [];
      try {
        await saveState(state);
      } catch (err) {
        // 清空失败会导致下次重复弹一次，属于可接受的小瑕疵
      }
    }
    return toasts;
  }

  /**
   * 核心编排：查余额 -> 换算 -> 成就 -> 排行榜 -> 落盘。
   * Popup 打开、手动刷新、后台定时任务都调用它。
   */
  async function refreshAll(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const trigger = opts.trigger || 'manual';
    const now = Date.now();

    const settings = await loadSettings();
    let state = await loadState(now);
    let achievements = await loadAchievements();

    /** 统一的失败返回，避免到处写重复对象 */
    function failResult(code, message, extra) {
      return Object.assign(
        {
          ok: false,
          code: code,
          message: message,
          state: state,
          settings: settings,
          achievements: achievements,
          newlyUnlocked: [],
          spent: 0,
          riceGained: 0,
          balance: state.balance,
          sync: null,
          trigger: trigger
        },
        extra || {}
      );
    }

    if (!settings.apiKey) {
      return failResult('NO_KEY', '还没填 API Key，大肥鱼饿得直翻白眼。');
    }

    const balanceResult = await fetchBalance(settings.apiKey);
    if (!balanceResult.ok) {
      state.lastCheckStatus = 'error';
      state.lastCheckAt = now;
      state.lastError = {
        code: balanceResult.code,
        message: balanceResult.message,
        at: now
      };
      try {
        await saveState(state);
      } catch (err) {
        // 保存失败不影响错误提示
      }
      return failResult(balanceResult.code, balanceResult.message, { balance: state.balance });
    }

    const applied = applyBalance(state, balanceResult, now);
    state = applied.state;
    state.lastCheckStatus = 'ok';
    state.lastError = null;
    state.lastCheckAt = now;

    // 第一轮成就判定：财富、连吃、特殊事件、已有排行榜状态
    let evalResult = evaluateAchievements(state, achievements, {
      now: now,
      joinedRank: state.joinedRank,
      rank: state.rankBest
    });
    achievements = evalResult.achievements;
    let newlyUnlocked = evalResult.newlyUnlocked.slice();
    if (newlyUnlocked.length > 0) {
      state.pendingToasts = appendToasts(state.pendingToasts, newlyUnlocked);
    }

    // 排行榜同步（可选）
    let syncResult = null;
    if (settings.syncEnabled && state.totalRice > 0) {
      const throttled = !opts.forceSync && now - state.lastSyncAt < SYNC_MIN_INTERVAL;
      const cooling = state.syncCooldownUntil && state.syncCooldownUntil > now;

      if (throttled || cooling) {
        state.lastSyncStatus = 'throttled';
        syncResult = {
          ok: false,
          skipped: true,
          rejected: false,
          code: 'THROTTLED',
          message: throttled ? '刚同步过，先让服务器喘口气。' : '上次成绩被拦截，冷却中。'
        };
      } else {
        syncResult = await syncRank({
          deviceId: state.deviceId,
          nickname: settings.nickname,
          totalRice: state.totalRice,
          apiBase: settings.apiBase
        });
        state = recordSyncResult(state, syncResult, now);

        if (syncResult.ok) {
          // 第二轮成就判定：鱼苗 / 深海巨物 / 鱼王
          const rankEval = evaluateAchievements(state, achievements, {
            now: now,
            joinedRank: true,
            rank: syncResult.rank
          });
          achievements = rankEval.achievements;
          if (rankEval.newlyUnlocked.length > 0) {
            newlyUnlocked = newlyUnlocked.concat(rankEval.newlyUnlocked);
            state.pendingToasts = appendToasts(state.pendingToasts, rankEval.newlyUnlocked);
          }
        }
      }
    }

    // 兜底限制一下 Toasts 长度
    state.pendingToasts = (state.pendingToasts || []).slice(-MAX_PENDING_TOASTS);

    try {
      await saveState(state);
      await saveAchievements(achievements);
    } catch (err) {
      // 写盘失败仍然把内存里的结果返回给 UI，用户至少能看到本次战果
      console.warn('[大肥鱼] 保存本地数据失败：', err);
    }

    return {
      ok: true,
      code: 'OK',
      message: applied.event === 'baseline' ? '已记录初始余额，之后消耗才算饭。' : '',
      state: state,
      settings: settings,
      achievements: achievements,
      newlyUnlocked: newlyUnlocked,
      spent: applied.spent,
      riceGained: applied.riceGained,
      balance: state.balance,
      sync: syncResult,
      trigger: trigger,
      event: applied.event
    };
  }

  /**
   * 后台定时任务入口：统一把异常吞掉，避免 Service Worker 因未捕获异常挂掉。
   */
  async function safeRefreshAll(options) {
    try {
      return await refreshAll(options);
    } catch (err) {
      console.warn('[大肥鱼] 自动刷新失败：', err);
      return {
        ok: false,
        code: 'UNKNOWN',
        message: '刷新时发生了未知错误：' + (err && err.message ? err.message : '未知'),
        state: null,
        settings: null,
        achievements: {},
        newlyUnlocked: [],
        spent: 0,
        riceGained: 0,
        balance: null,
        sync: null
      };
    }
  }

  /* ================================================================
   * 六、导出
   * ================================================================ */

  const BFF = {
    VERSION: VERSION,
    RICE_PER_YUAN: RICE_PER_YUAN,
    PRICE_PER_BOWL: PRICE_PER_BOWL,
    STORAGE_KEYS: STORAGE_KEYS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ACHIEVEMENTS: ACHIEVEMENTS,
    NICKNAME_MAX_LENGTH: NICKNAME_MAX_LENGTH,

    // 工具
    dateKey: dateKey,
    daysBetween: daysBetween,
    round1: round1,
    round2: round2,
    formatRice: formatRice,
    formatYuan: formatYuan,
    yuanToRice: yuanToRice,
    riceToYuan: riceToYuan,
    normalizeNickname: normalizeNickname,
    normalizeApiBase: normalizeApiBase,
    normalizeState: normalizeState,
    isUuid: isUuid,

    // 存储
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    loadState: loadState,
    saveState: saveState,
    loadAchievements: loadAchievements,
    saveAchievements: saveAchievements,
    loadRankCache: loadRankCache,
    clearAllData: clearAllData,

    // 网络
    fetchBalance: fetchBalance,
    syncRank: syncRank,
    fetchTop: fetchTop,
    refreshRank: refreshRank,

    // 逻辑
    applyBalance: applyBalance,
    evaluateAchievements: evaluateAchievements,
    recordSyncResult: recordSyncResult,
    consumePendingToasts: consumePendingToasts,

    // 编排
    refreshAll: refreshAll,
    safeRefreshAll: safeRefreshAll
  };

  root.BFF = BFF;
})(typeof globalThis !== 'undefined' ? globalThis : self);
