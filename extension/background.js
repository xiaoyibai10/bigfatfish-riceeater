/**
 * 大肥鱼的白饭日记 · MV3 Service Worker
 * ------------------------------------------------------------------
 * 这个文件运行在没有 DOM 的 Service Worker 环境里，职责只有四件事：
 *   1. 用 chrome.alarms 维护「定时刷新余额」的闹钟；
 *   2. 收到 BFF_ALARM_RESET / BFF_REFRESH_NOW 消息时执行对应动作；
 *   3. 监听 storage 变化，把「今日白饭碗数」更新到扩展图标角标上；
 *   4. 所有逻辑都用 try/catch 兜住，绝不抛出未捕获异常导致 SW 崩溃。
 *
 * 说明：manifests 里 background.service_worker 不是 module，
 * 所以这里用 importScripts('shared.js') 把共享核心逻辑 BFF 加载进来。
 */
'use strict';

importScripts('shared.js');

const BFF = globalThis.BFF;

/** 闹钟名称，必须与 popup.js / SPEC 保持一致 */
const ALARM_NAME = 'bff-balance-refresh';
/** 自动刷新允许的最小间隔（分钟），MV3 下限是 0.5 分钟，这里按产品要求从 15 起 */
const MIN_REFRESH_MINUTES = 15;
/** 自动刷新允许的最大间隔（分钟） */
const MAX_REFRESH_MINUTES = 720;
/** 角标底色：DeepSeek 蓝 */
const BADGE_COLOR = '#4D6BFE';
/** 角标文字颜色：白色 */
const BADGE_TEXT_COLOR = '#FFFFFF';
/** 今日白饭达到这个整数就显示 99+，避免角标文字过长 */
const BADGE_MAX_RICE = 100;

/* ================================================================
 * 一、通用工具
 * ================================================================ */

/** 把任意刷新间隔压到 [15, 720] 的整数分钟；非法值回落到默认 30 分钟 */
function clampRefreshMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, Math.round(n)));
}

/**
 * 直接读取原始 state（不做归一化、不写盘）。
 * 后台只需要 todayRice，用原始值可以避免 loadState 在特殊情况下触发额外写盘，
 * 从而彻底杜绝「读 state -> 写 state -> storage 事件 -> 再读 state」的循环风险。
 */
function readStateRaw() {
  return new Promise(function (resolve) {
    try {
      if (!BFF || !chrome || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get(BFF.STORAGE_KEYS.state, function (items) {
        if (chrome.runtime.lastError) {
          console.warn('[大肥鱼] 读取 state 失败：', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        const state = items && items[BFF.STORAGE_KEYS.state] ? items[BFF.STORAGE_KEYS.state] : null;
        resolve(state);
      });
    } catch (error) {
      console.warn('[大肥鱼] 读取 state 时发生异常：', error);
      resolve(null);
    }
  });
}

/* ================================================================
 * 二、闹钟管理
 * ================================================================ */

/**
 * 创建 / 重建自动刷新闹钟。
 * 周期取自 settings.refreshMinutes，并强制限制在 15–720 分钟之间。
 * 先 clear 再 create，保证用户改完间隔后不会同时跑两个不同周期的闹钟。
 */
async function ensureAlarm() {
  try {
    if (!BFF) {
      console.warn('[大肥鱼] shared.js 未加载，跳过闹钟创建。');
      return;
    }
    if (!chrome || !chrome.alarms) {
      console.warn('[大肥鱼] alarms 权限不可用，跳过闹钟创建。');
      return;
    }

    const settings = await BFF.loadSettings();
    const minutes = clampRefreshMinutes(settings.refreshMinutes);

    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: minutes,
      periodInMinutes: minutes
    });

    console.log('[大肥鱼] 自动刷新闹钟已就绪：每 ' + minutes + ' 分钟。');
  } catch (error) {
    console.warn('[大肥鱼] 创建自动刷新闹钟失败：', error);
  }
}

/* ================================================================
 * 三、角标（Badge）
 * ================================================================ */

/**
 * 根据 state.todayRice 更新扩展图标角标：
 *  - 今日白饭 < 1 碗：清空角标；
 *  - 否则显示取整后的碗数，>= 100 显示 '99+'；
 *  - 蓝底白字（setBadgeTextColor 在 Chrome 110+ 才支持，做特性检测）。
 */
async function updateBadge(knownState) {
  try {
    if (!chrome || !chrome.action) return;

    const state = knownState || (await readStateRaw());
    const todayRice = Number(state && state.todayRice);

    if (!Number.isFinite(todayRice) || todayRice < 1) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    const rounded = Math.floor(todayRice);
    const text = rounded >= BADGE_MAX_RICE ? '99+' : String(rounded);
    chrome.action.setBadgeText({ text: text });

    try {
      chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    } catch (colorError) {
      console.warn('[大肥鱼] 设置角标背景色失败：', colorError);
    }

    try {
      // Chrome 110+ 才有 setBadgeTextColor；低版本自动使用默认白色文字
      if (typeof chrome.action.setBadgeTextColor === 'function') {
        chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
      }
    } catch (textColorError) {
      console.warn('[大肥鱼] 设置角标文字颜色失败：', textColorError);
    }
  } catch (error) {
    console.warn('[大肥鱼] 更新角标失败：', error);
  }
}

/** 角标刷新防抖：后台可能连续写多次 storage，合并成一次角标更新 */
let badgeTimer = null;
let pendingBadgeState = null;

function scheduleBadgeUpdate(state) {
  pendingBadgeState = state || null;
  if (badgeTimer) return;
  badgeTimer = setTimeout(function () {
    badgeTimer = null;
    const nextState = pendingBadgeState;
    pendingBadgeState = null;
    updateBadge(nextState);
  }, 150);
}

/* ================================================================
 * 四、刷新流程
 * ================================================================ */

/**
 * 定时刷新：查余额 -> 换算白饭 -> 成就 -> 排行榜 -> 落盘（全部在 BFF.refreshAll 内完成）。
 * 失败只写中文日志，不影响 SW 存活。
 */
async function runAlarmRefresh() {
  try {
    if (!BFF) {
      console.warn('[大肥鱼] shared.js 未加载，跳过定时刷新。');
      return;
    }

    const result = await BFF.refreshAll({ trigger: 'alarm' });

    if (!result || !result.ok) {
      const code = result && result.code ? result.code : 'UNKNOWN';
      const message = result && result.message ? result.message : '未知错误';
      console.warn('[大肥鱼] 定时刷新未成功（' + code + '）：' + message);
      if (code === 'NO_KEY') return;
    }

    // 有结果就顺手更新角标；没有 state 时回退到读取原始 state
    await updateBadge(result && result.state ? result.state : null);
  } catch (error) {
    console.warn('[大肥鱼] 定时刷新发生异常：', error);
  }
}

/* ================================================================
 * 五、生命周期与消息
 * ================================================================ */

// 安装 / 更新：创建闹钟并初始化角标
chrome.runtime.onInstalled.addListener(function (details) {
  try {
    const reason = details && details.reason ? details.reason : 'unknown';
    console.log('[大肥鱼] 扩展已安装 / 更新，原因：' + reason);
    ensureAlarm();
    updateBadge();
  } catch (error) {
    console.warn('[大肥鱼] onInstalled 处理失败：', error);
  }
});

// 浏览器启动：确保闹钟仍然存在（alarms 本身会持久化，这里做一次兜底重建）
chrome.runtime.onStartup.addListener(function () {
  try {
    console.log('[大肥鱼] 浏览器已启动，检查自动刷新闹钟。');
    ensureAlarm();
    updateBadge();
  } catch (error) {
    console.warn('[大肥鱼] onStartup 处理失败：', error);
  }
});

// 闹钟到点：命中我们的闹钟才刷新
chrome.alarms.onAlarm.addListener(function (alarm) {
  try {
    if (!alarm || alarm.name !== ALARM_NAME) return;
    console.log('[大肥鱼] 自动刷新闹钟触发。');
    runAlarmRefresh();
  } catch (error) {
    console.warn('[大肥鱼] 处理闹钟事件失败：', error);
  }
});

/**
 * Popup 消息：
 *  - BFF_ALARM_RESET：按最新设置重建闹钟；
 *  - BFF_REFRESH_NOW：立即刷新并返回刷新结果。
 * 两个分支都是异步的，必须 return true 让 sendResponse 保持有效。
 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  try {
    const type = message && message.type;

    if (type === 'BFF_ALARM_RESET') {
      ensureAlarm()
        .then(function () {
          sendResponse({ ok: true, message: '自动刷新闹钟已重建' });
        })
        .catch(function (error) {
          console.warn('[大肥鱼] 重建闹钟失败：', error);
          sendResponse({ ok: false, message: '重建闹钟失败' });
        });
      return true;
    }

    if (type === 'BFF_REFRESH_NOW') {
      (async function () {
        try {
          if (!BFF) {
            sendResponse({ ok: false, code: 'UNKNOWN', message: '共享逻辑未加载' });
            return;
          }
          const result = await BFF.refreshAll({ trigger: 'manual' });
          await updateBadge(result && result.state ? result.state : null);
          sendResponse(result || { ok: false, code: 'UNKNOWN', message: '刷新结果为空' });
        } catch (error) {
          console.warn('[大肥鱼] 立即刷新失败：', error);
          sendResponse({
            ok: false,
            code: 'UNKNOWN',
            message: '刷新时发生未知错误：' + (error && error.message ? error.message : '未知')
          });
        }
      })();
      return true;
    }

    // 其它消息不处理，返回 false 表示不占用异步响应通道
    return false;
  } catch (error) {
    console.warn('[大肥鱼] 处理消息失败：', error);
    try {
      sendResponse({ ok: false, code: 'UNKNOWN', message: '后台处理消息失败' });
    } catch (respondError) {
      console.warn('[大肥鱼] 回复消息失败：', respondError);
    }
    return false;
  }
});

/* ================================================================
 * 六、storage 变化 -> 角标
 * ================================================================ */

chrome.storage.onChanged.addListener(function (changes, areaName) {
  try {
    if (areaName !== 'local' || !BFF) return;

    if (changes[BFF.STORAGE_KEYS.state]) {
      // 直接用变化后的新值计算角标，避免再次读盘
      const nextState = changes[BFF.STORAGE_KEYS.state].newValue;
      scheduleBadgeUpdate(nextState || null);
      return;
    }

    if (changes[BFF.STORAGE_KEYS.settings]) {
      // 设置变化不影响今日白饭，但按 SPEC 也要同步刷新一次角标；
      // 这里只读原始 state，不触发任何写盘。
      readStateRaw()
        .then(function (state) {
          updateBadge(state);
        })
        .catch(function (error) {
          console.warn('[大肥鱼] 设置变化后刷新角标失败：', error);
        });
    }
  } catch (error) {
    console.warn('[大肥鱼] 处理 storage 变化失败：', error);
  }
});

// Service Worker 每次被唤醒时也顺手校准一次角标（幂等操作）
updateBadge();
