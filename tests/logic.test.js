/**
 * 大肥鱼的白饭日记 · 核心逻辑测试
 * ------------------------------------------------------------------
 * 运行：node tests/logic.test.js
 * 说明：用 Node 的 vm 把 extension/shared.js 加载到一个带 chrome.storage 与 fetch
 *      桩的沙箱里，验证余额换算、连吃天数、成就判定、排行同步与整体刷新流程。
 *      不需要 Chrome，也不需要真实网络。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const nodeCrypto = require('crypto');

const SHARED_PATH = path.join(__dirname, '..', 'extension', 'shared.js');
const sharedSource = fs.readFileSync(SHARED_PATH, 'utf8');

/** 固定一个测试时间点：2026-11-05 12:00（本地时区） */
const NOW = new Date(2026, 10, 5, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const TEST_UUID = '123e4567-e89b-42d3-a456-426614174000';

/** 深拷贝，模拟 chrome.storage 的序列化行为 */
function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** 一个支持 Promise + 回调两种调用方式的 chrome.storage.local 假实现 */
function createStorage() {
  const data = {};
  function has(key) {
    return Object.prototype.hasOwnProperty.call(data, key);
  }
  const area = {
    get(keys, callback) {
      let result = {};
      if (typeof keys === 'string') {
        if (has(keys)) result[keys] = clone(data[keys]);
      } else if (Array.isArray(keys)) {
        keys.forEach(function (key) {
          if (has(key)) result[key] = clone(data[key]);
        });
      } else if (keys && typeof keys === 'object') {
        Object.keys(keys).forEach(function (key) {
          result[key] = has(key) ? clone(data[key]) : clone(keys[key]);
        });
      } else {
        Object.keys(data).forEach(function (key) {
          result[key] = clone(data[key]);
        });
      }
      const promise = Promise.resolve(result);
      if (typeof callback === 'function') promise.then(callback);
      return promise;
    },
    set(items, callback) {
      Object.keys(items || {}).forEach(function (key) {
        data[key] = clone(items[key]);
      });
      const promise = Promise.resolve();
      if (typeof callback === 'function') promise.then(function () { callback(); });
      return promise;
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(function (key) {
        delete data[key];
      });
      const promise = Promise.resolve();
      if (typeof callback === 'function') promise.then(function () { callback(); });
      return promise;
    }
  };
  return { data: data, area: area };
}

/** 构造一个最小可用的 fetch Response 假对象 */
function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async function () { return text; },
    json: async function () { return JSON.parse(text); }
  };
}

/**
 * 创建一个沙箱环境。
 * @param {{fetch?:Function}} options
 */
function createEnv(options) {
  const opts = options || {};
  const storage = createStorage();
  const chrome = {
    storage: { local: storage.area },
    runtime: { lastError: null }
  };
  const calls = [];
  const fetchImpl = opts.fetch || async function () {
    throw new Error('测试中出现了未预期的 fetch 调用');
  };
  const wrappedFetch = function (url, init) {
    calls.push({ url: String(url), init: init });
    return fetchImpl(url, init);
  };

  const context = vm.createContext({
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    fetch: wrappedFetch,
    chrome: chrome,
    crypto: nodeCrypto.webcrypto,
    URL: URL,
    AbortController: AbortController,
    // 下面几个是为了兼容不同 Node 版本的 fetch/abort 实现
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder
  });

  vm.runInContext(sharedSource, context, { filename: 'shared.js' });
  return {
    BFF: context.BFF,
    storage: storage,
    calls: calls,
    chrome: chrome
  };
}

/** 构造一个干净的 state（用给定时间归一化） */
function freshState(env, now) {
  return env.BFF.normalizeState(null, now || NOW);
}

/* ================================================================
 * 测试注册
 * ================================================================ */
const tests = [];
function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

/* ---------------------------- 1. 基础工具 ---------------------------- */
test('常量与换算：0.1 元 = 1 碗，格式化正确', function () {
  const env = createEnv();
  const BFF = env.BFF;
  assert.strictEqual(BFF.RICE_PER_YUAN, 10);
  assert.strictEqual(BFF.PRICE_PER_BOWL, 0.1);
  assert.strictEqual(BFF.yuanToRice(0.1), 1);
  assert.strictEqual(BFF.yuanToRice(5), 50);
  assert.strictEqual(BFF.riceToYuan(50), 5);
  assert.strictEqual(BFF.formatRice(12), '12');
  assert.strictEqual(BFF.formatRice(12.5), '12.5');
  assert.strictEqual(BFF.formatRice(0.1), '0.1');
  assert.strictEqual(BFF.formatYuan(110), '110.00');
  assert.strictEqual(BFF.formatYuan(5.678), '5.68');
});

test('日期工具：dateKey 本地日期、daysBetween 跨月正确', function () {
  const env = createEnv();
  const BFF = env.BFF;
  assert.strictEqual(BFF.dateKey(NOW), '2026-11-05');
  assert.strictEqual(BFF.daysBetween('2026-11-01', '2026-11-04'), 3);
  assert.strictEqual(BFF.daysBetween('2026-10-31', '2026-11-01'), 1);
  assert.strictEqual(BFF.daysBetween('2026-11-04', '2026-11-01'), -3);
  assert.strictEqual(BFF.daysBetween('bad', '2026-11-01'), null);
});

test('昵称清洗：去控制字符、截断 20 字、空值回落', function () {
  const env = createEnv();
  const BFF = env.BFF;
  assert.strictEqual(BFF.normalizeNickname('   '), '匿名肥鱼');
  assert.strictEqual(BFF.normalizeNickname('大\u0000肥\n鱼'), '大肥鱼');
  assert.strictEqual(BFF.normalizeNickname('鱼'.repeat(30)), '鱼'.repeat(20));
  assert.strictEqual(BFF.normalizeNickname('  小鱼  '), '小鱼');
});

test('normalizeState：deviceId 自动生成且为 UUID，跨天重置今日白饭', function () {
  const env = createEnv();
  const BFF = env.BFF;
  const state = BFF.normalizeState({ todayDate: '2000-01-01', todayRice: 66, totalRice: 88 }, NOW);
  assert.ok(BFF.isUuid(state.deviceId));
  assert.strictEqual(state.todayDate, '2026-11-05');
  assert.strictEqual(state.todayRice, 0);
  assert.strictEqual(state.totalRice, 88);
  assert.strictEqual(state.balance, null);
});

/* ---------------------------- 2. 余额换算 ---------------------------- */
test('applyBalance：首次只记基准，不产生白饭与成就', function () {
  const env = createEnv();
  const BFF = env.BFF;
  const state = freshState(env);
  const result = BFF.applyBalance(state, { totalBalance: 100 }, NOW);
  assert.strictEqual(result.event, 'baseline');
  assert.strictEqual(result.spent, 0);
  assert.strictEqual(result.state.balance, 100);
  assert.strictEqual(result.state.totalRice, 0);
  assert.strictEqual(result.state.baselineAt, NOW);

  const evalResult = BFF.evaluateAchievements(result.state, {}, { now: NOW });
  assert.strictEqual(evalResult.newlyUnlocked.length, 0);
});

test('applyBalance：消耗 5 元 = 50 碗，累计与今日同步增长', function () {
  const env = createEnv();
  const BFF = env.BFF;
  let state = BFF.applyBalance(freshState(env), { totalBalance: 100 }, NOW).state;
  const result = BFF.applyBalance(state, { totalBalance: 95 }, NOW + 3600000);
  assert.strictEqual(result.event, 'spend');
  assert.strictEqual(result.spent, 5);
  assert.strictEqual(result.riceGained, 50);
  assert.strictEqual(result.state.totalRice, 50);
  assert.strictEqual(result.state.totalSpent, 5);
  assert.strictEqual(result.state.todayRice, 50);
  assert.strictEqual(result.state.streakDays, 1);
  assert.strictEqual(result.state.lastEatDate, '2026-11-05');
  assert.strictEqual(result.state.maxSingleSpend, 5);
});

test('applyBalance：同一天多次消耗，连续天数不重复增加', function () {
  const env = createEnv();
  const BFF = env.BFF;
  let state = BFF.applyBalance(freshState(env), { totalBalance: 100 }, NOW).state;
  state = BFF.applyBalance(state, { totalBalance: 99 }, NOW + 1000).state;
  state = BFF.applyBalance(state, { totalBalance: 98 }, NOW + 2000).state;
  assert.strictEqual(state.streakDays, 1);
  assert.strictEqual(state.todayRice, 20);
  assert.strictEqual(state.totalRice, 20);
});

test('applyBalance：连续 3 天消耗 → 连续天数 3，并解锁「一日三餐」', function () {
  const env = createEnv();
  const BFF = env.BFF;
  let state = freshState(env);
  state = BFF.applyBalance(state, { totalBalance: 100 }, NOW).state;
  state = BFF.applyBalance(state, { totalBalance: 95 }, NOW + 1 * DAY).state;
  state = BFF.applyBalance(state, { totalBalance: 94 }, NOW + 2 * DAY).state;
  const third = BFF.applyBalance(state, { totalBalance: 93 }, NOW + 3 * DAY);
  assert.strictEqual(third.state.streakDays, 3);
  assert.strictEqual(third.state.todayRice, 10);
  const evalResult = BFF.evaluateAchievements(third.state, {}, { now: NOW + 3 * DAY });
  const ids = evalResult.newlyUnlocked.map(function (item) { return item.id; });
  assert.ok(ids.indexOf('streak_three') >= 0);
  assert.ok(ids.indexOf('wealth_rookie') >= 0);
  assert.ok(ids.indexOf('wealth_killer') >= 0);
});

test('applyBalance：中断一天后连续天数重置为 1', function () {
  const env = createEnv();
  const BFF = env.BFF;
  let state = freshState(env);
  state = BFF.applyBalance(state, { totalBalance: 100 }, NOW).state;
  // 当天先吃一口，把昨天标记出来
  state = BFF.applyBalance(state, { totalBalance: 99 }, NOW + 1000).state;
  state = BFF.applyBalance(state, { totalBalance: 98 }, NOW + DAY).state;
  assert.strictEqual(state.streakDays, 2);
  const afterGap = BFF.applyBalance(state, { totalBalance: 97 }, NOW + 3 * DAY);
  assert.strictEqual(afterGap.state.streakDays, 1);
});

test('applyBalance：余额增加 → 赛博减肥；余额不足 1 元 → 濒死体验', function () {
  const env = createEnv();
  const BFF = env.BFF;
  let state = BFF.applyBalance(freshState(env), { totalBalance: 100 }, NOW).state;
  const refund = BFF.applyBalance(state, { totalBalance: 101.5 }, NOW + 1000);
  assert.strictEqual(refund.event, 'refund');
  assert.strictEqual(refund.spent, 0);
  assert.strictEqual(refund.state.balanceIncreaseCount, 1);
  assert.strictEqual(refund.state.totalRice, 0);

  const nearDeath = BFF.applyBalance(refund.state, { totalBalance: 0.5 }, NOW + 2000);
  const evalResult = BFF.evaluateAchievements(nearDeath.state, {}, { now: NOW + 2000 });
  const ids = evalResult.newlyUnlocked.map(function (item) { return item.id; });
  assert.ok(ids.indexOf('special_diet') >= 0);
  assert.ok(ids.indexOf('special_near_death') >= 0);
});

test('applyBalance：单次消耗 10.5 元 → 暴饮暴食', function () {
  const env = createEnv();
  const BFF = env.BFF;
  let state = BFF.applyBalance(freshState(env), { totalBalance: 100 }, NOW).state;
  const result = BFF.applyBalance(state, { totalBalance: 89.5 }, NOW + 1000);
  assert.strictEqual(result.spent, 10.5);
  assert.strictEqual(result.riceGained, 105);
  assert.strictEqual(result.state.maxSingleSpend, 10.5);
  const evalResult = BFF.evaluateAchievements(result.state, {}, { now: NOW + 1000 });
  const ids = evalResult.newlyUnlocked.map(function (item) { return item.id; });
  assert.ok(ids.indexOf('special_binge') >= 0);
});

/* ---------------------------- 3. 成就判定 ---------------------------- */
test('成就：连续 3 天没吃上饭 → 冬眠', function () {
  const env = createEnv();
  const BFF = env.BFF;
  const state = freshState(env);
  state.balance = 50;
  state.lastEatDate = BFF.dateKey(NOW - 4 * DAY);
  state.lastEatAt = NOW - 4 * DAY;
  const evalResult = BFF.evaluateAchievements(state, {}, { now: NOW });
  const ids = evalResult.newlyUnlocked.map(function (item) { return item.id; });
  assert.ok(ids.indexOf('special_hibernation') >= 0);

  // 只饿 2 天时不解锁
  const notEnough = freshState(env);
  notEnough.lastEatDate = BFF.dateKey(NOW - 2 * DAY);
  const evalResult2 = BFF.evaluateAchievements(notEnough, {}, { now: NOW });
  const ids2 = evalResult2.newlyUnlocked.map(function (item) { return item.id; });
  assert.strictEqual(ids2.indexOf('special_hibernation'), -1);
});

test('成就：财富阶级按累计碗数依次解锁', function () {
  const env = createEnv();
  const BFF = env.BFF;
  const state = freshState(env);
  state.totalRice = 200;
  const evalResult = BFF.evaluateAchievements(state, {}, { now: NOW });
  const ids = evalResult.newlyUnlocked.map(function (item) { return item.id; });
  // vm 沙箱里的数组与宿主 Array 原型不同，用 join 比较避免跨 realm 误判
  assert.strictEqual(ids.join(','), 'wealth_rookie,wealth_killer,wealth_chicken');
});

test('成就：排行榜名次 → 鱼苗 / 深海巨物 / 鱼王', function () {
  const env = createEnv();
  const BFF = env.BFF;
  const state = freshState(env);

  const third = BFF.evaluateAchievements(state, {}, { now: NOW, joinedRank: true, rank: 3 });
  const ids = third.newlyUnlocked.map(function (item) { return item.id; });
  assert.strictEqual(ids.join(','), 'rank_fry,rank_whale');

  const first = BFF.evaluateAchievements(state, third.achievements, { now: NOW, joinedRank: true, rank: 1 });
  const ids2 = first.newlyUnlocked.map(function (item) { return item.id; });
  assert.strictEqual(ids2.join(','), 'rank_king');
});

test('成就：已解锁不会重复解锁，unlockedAt 稳定', function () {
  const env = createEnv();
  const BFF = env.BFF;
  const state = freshState(env);
  state.totalRice = 60;
  const first = BFF.evaluateAchievements(state, {}, { now: NOW });
  const second = BFF.evaluateAchievements(state, first.achievements, { now: NOW + 1000 });
  assert.strictEqual(second.newlyUnlocked.length, 0);
  assert.strictEqual(first.achievements.wealth_rookie.unlockedAt, NOW);
});

test('16 个成就目录齐全且 id 唯一', function () {
  const env = createEnv();
  const BFF = env.BFF;
  assert.strictEqual(BFF.ACHIEVEMENTS.length, 16);
  const ids = BFF.ACHIEVEMENTS.map(function (item) { return item.id; });
  assert.strictEqual(new Set(ids).size, 16);
  const groups = {};
  BFF.ACHIEVEMENTS.forEach(function (item) {
    groups[item.group] = (groups[item.group] || 0) + 1;
  });
  assert.deepStrictEqual(groups, { wealth: 6, streak: 3, special: 4, rank: 3 });
});

/* ---------------------------- 4. 网络与同步 ---------------------------- */
test('fetchBalance：CNY 优先解析；401 判 AUTH；空数组判 API 错误', async function () {
  let status = 200;
  let payload = {
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '1.00' },
      { currency: 'CNY', total_balance: '110.00' }
    ]
  };
  const env = createEnv({
    fetch: async function () {
      return jsonResponse(status, payload);
    }
  });
  const ok = await env.BFF.fetchBalance('sk-test');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.totalBalance, 110);
  assert.strictEqual(ok.currency, 'CNY');

  status = 401;
  const auth = await env.BFF.fetchBalance('sk-bad');
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.code, 'AUTH');

  status = 200;
  payload = { is_available: true, balance_infos: [] };
  const empty = await env.BFF.fetchBalance('sk-test');
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.code, 'API');

  const noKey = await env.BFF.fetchBalance('   ');
  assert.strictEqual(noKey.code, 'NO_KEY');
});

test('fetchBalance：网络异常与超时分别映射 NETWORK / TIMEOUT', async function () {
  const networkEnv = createEnv({
    fetch: async function () {
      throw new Error('boom');
    }
  });
  const network = await networkEnv.BFF.fetchBalance('sk-test');
  assert.strictEqual(network.code, 'NETWORK');

  const timeoutEnv = createEnv({
    fetch: async function () {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
  });
  const timeout = await timeoutEnv.BFF.fetchBalance('sk-test');
  assert.strictEqual(timeout.code, 'TIMEOUT');
});

test('syncRank：昵称截断、碗数 round1、名次解析', async function () {
  let captured = null;
  const env = createEnv({
    fetch: async function (url, init) {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return jsonResponse(200, { ok: true, rejected: false, rank: 12, totalRice: 66.6 });
    }
  });
  const result = await env.BFF.syncRank({
    deviceId: TEST_UUID,
    nickname: '鱼'.repeat(30),
    totalRice: 66.64,
    apiBase: 'https://demo.vercel.app/'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.rank, 12);
  assert.strictEqual(captured.url, 'https://demo.vercel.app/api/rank/update');
  assert.strictEqual(captured.body.totalRice, 66.6);
  assert.strictEqual(captured.body.nickname, '鱼'.repeat(20));
  assert.strictEqual(captured.body.deviceId, TEST_UUID);
});

test('syncRank：防作弊拒绝透传 reason / message / retryAfterSeconds', async function () {
  const env = createEnv({
    fetch: async function () {
      return jsonResponse(200, {
        ok: false,
        rejected: true,
        reason: 'RATE_LIMIT',
        message: '成绩被没收',
        retryAfterSeconds: 240
      });
    }
  });
  const result = await env.BFF.syncRank({
    deviceId: TEST_UUID,
    nickname: '小鱼',
    totalRice: 600,
    apiBase: 'https://demo.vercel.app'
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rejected, true);
  assert.strictEqual(result.code, 'RATE_LIMIT');
  assert.strictEqual(result.retryAfterSeconds, 240);

  const badDevice = await env.BFF.syncRank({ deviceId: 'oops', nickname: '小鱼', totalRice: 1 });
  assert.strictEqual(badDevice.code, 'NO_DEVICE');
});

test('recordSyncResult：记录最佳名次、鱼王标记、拒绝后进入 5 分钟冷却', function () {
  const env = createEnv();
  const BFF = env.BFF;
  let state = freshState(env);

  state = BFF.recordSyncResult(state, { ok: true, rank: 5, totalRice: 30 }, NOW);
  assert.strictEqual(state.joinedRank, true);
  assert.strictEqual(state.rankBest, 5);
  assert.strictEqual(state.lastSyncedRice, 30);

  state = BFF.recordSyncResult(state, { ok: true, rank: 2, totalRice: 30 }, NOW + 1000);
  assert.strictEqual(state.rankBest, 2);
  assert.strictEqual(state.rankIsFirst, false);

  state = BFF.recordSyncResult(state, { ok: true, rank: 1, totalRice: 30 }, NOW + 2000);
  assert.strictEqual(state.rankBest, 1);
  assert.strictEqual(state.rankIsFirst, true);

  const rejected = BFF.recordSyncResult(
    state,
    { ok: false, rejected: true, code: 'RATE_LIMIT', message: '涨太快' },
    NOW + 3000
  );
  assert.strictEqual(rejected.lastSyncStatus, 'rejected');
  assert.strictEqual(rejected.lastSyncedRice, 30);
  assert.strictEqual(rejected.syncCooldownUntil, NOW + 3000 + 5 * 60 * 1000);
  assert.strictEqual(rejected.lastSyncError.code, 'RATE_LIMIT');
});

test('fetchTop：清洗脏数据、返回我的名次、拒绝非法 deviceId 参数', async function () {
  let capturedUrl = '';
  const env = createEnv({
    fetch: async function (url) {
      capturedUrl = String(url);
      return jsonResponse(200, {
        ok: true,
        updatedAt: NOW,
        ranks: [
          { rank: 1, nickname: '榜首鱼', totalRice: 900.5 },
          { rank: 2, nickname: '  第二名  ', totalRice: '12.3' },
          { nickname: '', totalRice: null }
        ],
        me: { rank: 2, nickname: '我', totalRice: 12.3 }
      });
    }
  });
  const result = await env.BFF.fetchTop({ apiBase: 'https://demo.vercel.app', deviceId: TEST_UUID, limit: 50 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ranks.length, 3);
  assert.strictEqual(result.ranks[0].nickname, '榜首鱼');
  assert.strictEqual(result.ranks[1].nickname, '第二名');
  assert.strictEqual(result.ranks[1].totalRice, 12.3);
  assert.strictEqual(result.ranks[2].nickname, '匿名肥鱼');
  assert.strictEqual(result.me.rank, 2);
  assert.ok(capturedUrl.indexOf('deviceId=' + TEST_UUID) >= 0);
});

/* ---------------------------- 5. 整体刷新流程 ---------------------------- */
test('refreshAll：无 Key 直接 NO_KEY，不发起网络请求', async function () {
  const env = createEnv();
  const result = await env.BFF.refreshAll({ trigger: 'popup' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'NO_KEY');
  assert.strictEqual(env.calls.length, 0);
});

test('refreshAll：首次只记基准；第二次消耗 5 元触发成就与排行榜同步', async function () {
  let balance = 100;
  let rankUpdates = 0;
  const env = createEnv({
    fetch: async function (url, init) {
      const target = String(url);
      if (target.indexOf('api.deepseek.com') >= 0) {
        return jsonResponse(200, {
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: balance.toFixed(2) }]
        });
      }
      if (target.indexOf('/api/rank/update') >= 0) {
        rankUpdates += 1;
        const body = JSON.parse(init.body);
        return jsonResponse(200, { ok: true, rejected: false, rank: 7, totalRice: body.totalRice });
      }
      return jsonResponse(404, { ok: false, error: 'NOT_FOUND' });
    }
  });

  await env.BFF.saveSettings({ apiKey: 'sk-test', nickname: '测试鱼', apiBase: 'https://demo.vercel.app' });

  const first = await env.BFF.refreshAll({ trigger: 'popup' });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.event, 'baseline');
  assert.strictEqual(first.state.balance, 100);
  assert.strictEqual(first.state.totalRice, 0);
  assert.strictEqual(first.newlyUnlocked.length, 0);
  assert.strictEqual(first.sync, null);
  assert.strictEqual(rankUpdates, 0);

  balance = 95;
  const second = await env.BFF.refreshAll({ trigger: 'popup' });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.spent, 5);
  assert.strictEqual(second.riceGained, 50);
  assert.strictEqual(second.state.totalRice, 50);
  assert.strictEqual(second.state.joinedRank, true);
  assert.strictEqual(second.state.rankBest, 7);
  assert.strictEqual(second.state.lastSyncedRice, 50);
  assert.strictEqual(rankUpdates, 1);

  const ids = second.newlyUnlocked.map(function (item) { return item.id; });
  assert.ok(ids.indexOf('wealth_rookie') >= 0);
  assert.ok(ids.indexOf('wealth_killer') >= 0);
  assert.ok(ids.indexOf('rank_fry') >= 0);
  assert.strictEqual(second.state.pendingToasts.length, 3);

  // Toast 读走一次后必须清空
  const toasts = await env.BFF.consumePendingToasts();
  assert.strictEqual(toasts.length, 3);
  const again = await env.BFF.consumePendingToasts();
  assert.strictEqual(again.length, 0);

  // 落盘检查
  const stored = env.storage.data.bff_state;
  assert.strictEqual(stored.totalRice, 50);
  assert.strictEqual(stored.balance, 95);
  const storedAchievements = env.storage.data.bff_achievements;
  assert.ok(storedAchievements.wealth_rookie);
  assert.ok(storedAchievements.rank_fry);
});

test('refreshAll：API Key 失效时保留旧余额并记录 AUTH 错误', async function () {
  const env = createEnv({
    fetch: async function () {
      return jsonResponse(401, { error: 'invalid token' });
    }
  });
  await env.BFF.saveSettings({ apiKey: 'sk-bad' });
  const result = await env.BFF.refreshAll();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'AUTH');
  assert.strictEqual(result.state.lastCheckStatus, 'error');
  assert.strictEqual(result.state.lastError.code, 'AUTH');
});

test('refreshAll：排行榜被防作弊拒绝时只记录状态，不影响主流程', async function () {
  let balance = 100;
  const env = createEnv({
    fetch: async function (url, init) {
      const target = String(url);
      if (target.indexOf('api.deepseek.com') >= 0) {
        return jsonResponse(200, {
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: balance.toFixed(2) }]
        });
      }
      if (target.indexOf('/api/rank/update') >= 0) {
        return jsonResponse(200, {
          ok: false,
          rejected: true,
          reason: 'RATE_LIMIT',
          message: '涨太快了',
          retryAfterSeconds: 200
        });
      }
      return jsonResponse(404, {});
    }
  });
  await env.BFF.saveSettings({ apiKey: 'sk-test', nickname: '小鱼', apiBase: 'https://demo.vercel.app' });

  await env.BFF.refreshAll();
  balance = 90;
  const result = await env.BFF.refreshAll();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.spent, 10);
  assert.strictEqual(result.sync.rejected, true);
  assert.strictEqual(result.state.lastSyncStatus, 'rejected');
  assert.strictEqual(result.state.joinedRank, false);
  assert.ok(result.state.syncCooldownUntil > Date.now());
  const ids = result.newlyUnlocked.map(function (item) { return item.id; });
  assert.strictEqual(ids.indexOf('rank_fry'), -1);
});

test('refreshRank：拉榜单成功后写入本地缓存', async function () {
  const env = createEnv({
    fetch: async function () {
      return jsonResponse(200, {
        ok: true,
        updatedAt: NOW,
        ranks: [{ rank: 1, nickname: '大鱼', totalRice: 100 }],
        me: null
      });
    }
  });
  const result = await env.BFF.refreshRank({ apiBase: 'https://demo.vercel.app', limit: 50 });
  assert.strictEqual(result.ok, true);
  const cache = await env.BFF.loadRankCache();
  assert.strictEqual(cache.ranks.length, 1);
  assert.strictEqual(cache.ranks[0].nickname, '大鱼');
  assert.strictEqual(cache.fetchedAt, NOW);
});

/* ================================================================
 * 运行器
 * ================================================================ */
(async function main() {
  let passed = 0;
  const failures = [];
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log('✅ ' + item.name);
    } catch (error) {
      failures.push({ name: item.name, error: error });
      console.error('❌ ' + item.name);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log('\n----------------------------------------');
  console.log('通过 ' + passed + ' / ' + tests.length + '，失败 ' + failures.length);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
})();
