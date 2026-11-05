/**
 * 大肥鱼的白饭日记 · Popup 交互脚本
 * ------------------------------------------------------------------
 * 职责边界（严格按 SPEC §7.7）：
 *  - 本文件只负责「渲染 + 交互 + Toast」，不重复实现任何换算 / 成就判定逻辑；
 *  - 所有存储、网络、成就能力一律通过 globalThis.BFF（shared.js）调用；
 *  - 所有来自用户输入或服务端的文本都用 textContent 插入 DOM，杜绝 XSS；
 *  - chrome.storage.onChanged 只做重渲染，绝不在这里发起网络请求。
 */
(function () {
  'use strict';

  /* ================================================================
   * 0. 依赖检查：shared.js 没加载成功时给出可读提示，而不是白屏
   * ================================================================ */
  if (!globalThis.BFF) {
    document.addEventListener('DOMContentLoaded', function () {
      const main = document.querySelector('.main');
      if (main) {
        main.textContent = '核心逻辑 shared.js 加载失败，请重新加载扩展（重新打开 Popup）。';
      }
    });
    return;
  }

  const BFF = globalThis.BFF;

  /* ================================================================
   * 1. 常量：Tab、错误文案映射、成就分组、随机昵称池
   * ================================================================ */

  /** 三个业务 Tab（设置面板是独立面板，不占用 Tab 位） */
  const TAB_KEYS = ['home', 'achievements', 'rank'];

  /** 排行榜结果内存缓存 60 秒，避免频繁切 Tab 重复请求 */
  const RANK_CACHE_TTL = 60 * 1000;

  /** 单次拉取排行榜的条数（BFF 内部会限制在 1–100） */
  const RANK_LIMIT = 50;

  /** 设置里允许的自动刷新间隔（分钟） */
  const REFRESH_OPTIONS = [15, 30, 60, 120];

  /**
   * 统一错误码中文映射（SPEC §7.7）。
   * 服务端 / shared.js 传来的原始 message 只作为兜底，优先展示固定文案，
   * 保证用户看到的是「人话」而不是英文错误码。
   */
  const ERROR_TEXT = {
    NO_KEY: '还没填 API Key',
    AUTH: 'API Key 无效或已过期',
    TIMEOUT: '请求超时，鱼都饿晕了',
    NETWORK: '网络不通，检查代理/网络',
    HTTP: '服务器返回异常',
    API: '余额接口返回异常',
    PARSE: '余额数据解析失败',
    SERVER: '服务器开小差了，稍后再试',
    UNKNOWN: '出现未知错误，请稍后再试'
  };

  /** 成就分组顺序与标题（顺序固定：财富 → 连吃 → 特殊 → 排行榜） */
  const GROUP_ORDER = ['wealth', 'streak', 'special', 'rank'];
  const GROUP_META = {
    wealth: { title: '财富阶级', emoji: '💰' },
    streak: { title: '连吃天数', emoji: '🔥' },
    special: { title: '特殊事件', emoji: '✨' },
    rank: { title: '排行榜互动', emoji: '🏆' }
  };

  /** 随机昵称池：点击「🎲 换一个」时从里面挑，不涉及任何业务判定 */
  const RANDOM_NICKNAMES = [
    '白饭永动机',
    '赛博干饭王',
    '米饭拌饭',
    '大肥鱼本鱼',
    '干饭不积极',
    '深夜食堂鱼',
    '一粒米都不剩',
    '碳水战神',
    '饭桶本桶',
    '清蒸大肥鱼',
    '红烧大肥鱼',
    '白饭刺客',
    '鱼塘管理员',
    '摸鱼干饭两不误',
    '只吃白饭的鱼',
    '食堂扛把子',
    '干饭许可证',
    '饭点准时鱼',
    '今天也吃白饭',
    '饿到啃键盘'
  ];

  /* ================================================================
   * 2. 运行时 UI 状态（不落盘，只服务于本次 Popup 会话）
   * ================================================================ */
  const ui = {
    settings: null,          // BFF.Settings
    state: null,             // BFF.State
    achievements: {},        // { [id]: { unlockedAt } }
    activeTab: 'home',
    settingsOpen: false,     // 设置面板是否展开
    settingsDirty: false,    // 表单是否被用户改过（避免 storage 变化冲掉输入）
    refreshing: false,       // 是否正在刷新（防连点）
    testing: false,          // 是否正在测试连接
    saving: false,           // 是否正在保存设置
    clearing: false,         // 是否正在清空数据
    rankData: null,          // 最近一次榜单结果
    rankLoadedAt: 0,         // 榜单结果写入内存的时间戳（用于 60 秒缓存）
    rankLoading: false,
    rankError: '',           // 榜单失败文案
    renderTimer: 0,          // storage.onChanged 的重渲染防抖定时器
    highlightIds: new Set(), // 本次新解锁、需要高亮的成就 id
    highlightTimer: 0,
    dismissedErrorAt: 0     // 用户手动关闭错误条时对应错误时间戳（避免重渲染又冒出来）
  };

  /* ================================================================
   * 3. DOM 缓存
   * ================================================================ */
  const el = {};

  /** 便捷的 getElementById 包装 */
  function $id(id) {
    return document.getElementById(id);
  }

  function cacheDom() {
    el.main = document.querySelector('.main');

    // Header
    el.statusDot = $id('statusDot');
    el.settingsBtn = $id('settingsBtn');

    // Tab 栏
    el.tabbar = $id('tabbar');

    // 干饭面板
    el.noKeyCard = $id('noKeyCard');
    el.goSettingsBtn = $id('goSettingsBtn');
    el.errorBar = $id('errorBar');
    el.errorText = $id('errorText');
    el.errorClose = $id('errorClose');
    el.fishBubble = $id('fishBubble');
    el.keyStats = $id('keyStats');
    el.statToday = $id('statToday');
    el.statBalance = $id('statBalance');
    el.keyMeta = $id('keyMeta');
    el.statTotal = $id('statTotal');
    el.statStreak = $id('statStreak');
    el.statLastUpdate = $id('statLastUpdate');
    el.keyActions = $id('keyActions');
    el.refreshBtn = $id('refreshBtn');
    el.refreshLabel = $id('refreshLabel');
    el.lastGain = $id('lastGain');

    // 成就墙面板
    el.achCount = $id('achCount');
    el.achProgress = $id('achProgress');
    el.achProgressFill = $id('achProgressFill');
    el.achGroups = $id('achGroups');

    // 干饭榜面板
    el.rankRefreshBtn = $id('rankRefreshBtn');
    el.rankUpdated = $id('rankUpdated');
    el.rankBody = $id('rankBody');
    el.myRankCard = $id('myRankCard');
    el.myRankText = $id('myRankText');
    el.myRankValue = $id('myRankValue');

    // 设置面板
    el.settingsBackBtn = $id('settingsBackBtn');
    el.apiKeyInput = $id('apiKeyInput');
    el.toggleKeyBtn = $id('toggleKeyBtn');
    el.nicknameInput = $id('nicknameInput');
    el.randomNickBtn = $id('randomNickBtn');
    el.syncToggle = $id('syncToggle');
    el.refreshSelect = $id('refreshSelect');
    el.apiBaseInput = $id('apiBaseInput');
    el.saveSettingsBtn = $id('saveSettingsBtn');
    el.testConnBtn = $id('testConnBtn');
    el.testResult = $id('testResult');
    el.clearDataBtn = $id('clearDataBtn');

    // Toast
    el.toastContainer = $id('toastContainer');
  }

  /* ================================================================
   * 4. 通用小工具
   * ================================================================ */

  /** 补零：3 -> '03' */
  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /** 时间戳 -> 'HH:mm:ss'，无效或 0 显示 '--:--:--' */
  function formatClock(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return '--:--:--';
    const date = new Date(ts);
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  /** 时间戳 -> 'M月D日'（成就解锁日期） */
  function formatShortDate(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const date = new Date(ts);
    return date.getMonth() + 1 + '月' + date.getDate() + '日';
  }

  /**
   * 错误码 -> 中文文案。
   * 优先使用固定映射；映射不到时才退回 shared.js 提供的 message。
   */
  function messageFor(code, fallback) {
    if (code && Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) {
      return ERROR_TEXT[code];
    }
    if (fallback && typeof fallback === 'string') return fallback;
    return ERROR_TEXT.UNKNOWN;
  }

  /** 把任意设置里的刷新间隔对齐到下拉框的四个选项之一 */
  function selectRefreshMinutes(value) {
    const n = Number(value);
    if (REFRESH_OPTIONS.indexOf(n) >= 0) return n;
    const target = Number.isFinite(n) ? n : 30;
    let best = REFRESH_OPTIONS[0];
    let bestDiff = Infinity;
    REFRESH_OPTIONS.forEach(function (option) {
      const diff = Math.abs(option - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = option;
      }
    });
    return best;
  }

  /** 按 Unicode 字符截断昵称，避免把 emoji 劈成两半 */
  function truncateNickname(text) {
    const limit = Number(BFF.NICKNAME_MAX_LENGTH) || 20;
    const chars = Array.from(String(text || ''));
    return chars.slice(0, limit).join('');
  }

  /* ================================================================
   * 5. Toast
   * ================================================================ */

  /**
   * 显示一个 Toast。
   * @param {string} title 主文案（永远是纯文本，用 textContent 插入）
   * @param {{desc?:string, emoji?:string, type?:string, duration?:number}} options
   */
  function showToast(title, options) {
    if (!el.toastContainer) return;
    const opts = options || {};

    // 同时最多保留 4 个，避免刷屏挡住界面
    while (el.toastContainer.children.length >= 4) {
      const oldest = el.toastContainer.firstElementChild;
      if (!oldest) break;
      el.toastContainer.removeChild(oldest);
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    if (opts.type === 'achievement') toast.classList.add('achievement');
    if (opts.type === 'error') toast.classList.add('error');

    const emoji = document.createElement('span');
    emoji.className = 'toast-emoji';
    emoji.textContent = opts.emoji || '🍚';

    const body = document.createElement('div');
    body.className = 'toast-body';

    const titleNode = document.createElement('div');
    titleNode.className = 'toast-title';
    titleNode.textContent = String(title || '');
    body.appendChild(titleNode);

    if (opts.desc) {
      const descNode = document.createElement('div');
      descNode.className = 'toast-desc';
      descNode.textContent = String(opts.desc);
      body.appendChild(descNode);
    }

    toast.appendChild(emoji);
    toast.appendChild(body);
    el.toastContainer.appendChild(toast);

    const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 3200;
    const timer = window.setTimeout(function () {
      removeToast(toast);
    }, duration);

    // 点击可以提前关闭
    toast.addEventListener('click', function () {
      window.clearTimeout(timer);
      removeToast(toast);
    });
  }

  /** 播放退场动画后移除 Toast 节点 */
  function removeToast(toast) {
    if (!toast || toast.classList.contains('is-hiding')) return;
    toast.classList.add('is-hiding');
    window.setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 260);
  }

  /** 成就解锁专用 Toast：emoji 会被 CSS 放大弹跳 */
  function showAchievementToast(item) {
    if (!item) return;
    showToast('解锁成就：' + (item.name || '神秘成就'), {
      desc: item.desc || '',
      emoji: item.emoji || '🏆',
      type: 'achievement',
      duration: 4600
    });
  }

  /**
   * 读走并展示所有待展示的成就 Toast（包含后台定时刷新攒下的）。
   * consumePendingToasts 会清空队列，因此每次刷新后调用一次即可。
   */
  async function flushPendingToasts() {
    try {
      const toasts = await BFF.consumePendingToasts();
      if (!Array.isArray(toasts) || toasts.length === 0) return;

      toasts.forEach(function (item, index) {
        window.setTimeout(function () {
          showAchievementToast(item);
        }, index * 420);
      });

      // 解锁状态可能刚刚变化：重新读成就表并高亮新卡片
      ui.achievements = await BFF.loadAchievements();
      toasts.forEach(function (item) {
        if (item && item.id) ui.highlightIds.add(item.id);
      });
      renderAchievements();
      scheduleHighlightClear();
    } catch (error) {
      console.warn('[大肥鱼] 展示成就 Toast 失败：', error);
    }
  }

  /** 高亮动画播完后清掉标记，避免每次重渲染都闪一下 */
  function scheduleHighlightClear() {
    if (ui.highlightTimer) window.clearTimeout(ui.highlightTimer);
    ui.highlightTimer = window.setTimeout(function () {
      ui.highlightTimer = 0;
      ui.highlightIds.clear();
      const nodes = document.querySelectorAll('.ach-card.unlock-flash');
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].classList.remove('unlock-flash');
      }
    }, 1800);
  }

  /* ================================================================
   * 6. Header 状态与首页渲染
   * ================================================================ */

  /**
   * 更新 Header 右上角状态圆点。
   * @param {'configured'|'unconfigured'|'loading'} [mode]
   */
  function updateStatus(mode) {
    if (!el.statusDot) return;
    let status = mode;
    if (!status) {
      status = ui.settings && ui.settings.apiKey ? 'configured' : 'unconfigured';
    }
    if (ui.refreshing) status = 'loading';

    el.statusDot.classList.remove('configured', 'loading');
    if (status === 'configured') el.statusDot.classList.add('configured');
    if (status === 'loading') el.statusDot.classList.add('loading');

    const text = status === 'loading' ? '请求中' : status === 'configured' ? '已配置' : '未配置';
    el.statusDot.setAttribute('title', text);
    el.statusDot.setAttribute('aria-label', '状态：' + text);
  }

  /** 显示红色错误条 */
  function showErrorBar(message) {
    if (!el.errorBar || !el.errorText) return;
    el.errorText.textContent = String(message || ERROR_TEXT.UNKNOWN);
    el.errorBar.classList.remove('hidden');
  }

  /** 隐藏红色错误条 */
  function hideErrorBar() {
    if (!el.errorBar) return;
    el.errorBar.classList.add('hidden');
  }

  /**
   * 根据当前 state 决定是否显示错误条。
   * NO_KEY 不走红条，而是显示引导卡片（由 renderHome 控制）。
   */
  function renderErrorBar(configured) {
    const state = ui.state || {};
    const lastError = state.lastError;
    if (!configured || state.lastCheckStatus !== 'error' || !lastError) {
      hideErrorBar();
      return;
    }
    // 用户已经手动关掉过这条错误，就不要在每次重渲染时再弹出来
    if (ui.dismissedErrorAt && Number(lastError.at) && ui.dismissedErrorAt >= Number(lastError.at)) {
      hideErrorBar();
      return;
    }
    showErrorBar(messageFor(lastError.code, lastError.message));
  }

  /** 鱼旁边的气泡文案：根据配置 / 错误 / 今日战果给出不同反应 */
  function buildBubbleText(settings, state) {
    if (!settings.apiKey) return '我还没吃饱，快给我一把 API Key 吧～';
    if (state.lastCheckStatus === 'error') return '饿晕了…网络好像不太行。';
    const todayRice = Number(state.todayRice) || 0;
    if (todayRice > 0) return '今天已经干了 ' + BFF.formatRice(todayRice) + ' 碗白饭！';
    if (state.lastCheckStatus === 'ok') return '余额没变，鱼在认真摸鱼。';
    return '今天也要好好干饭哦～';
  }

  /** 主界面（干饭面板）渲染 */
  function renderHome() {
    if (!el.statToday) return;
    const settings = ui.settings || BFF.DEFAULT_SETTINGS;
    const state = ui.state || {};
    const configured = !!settings.apiKey;

    // 未配置 Key：显示引导卡片，隐藏需要 Key 的数据区
    el.noKeyCard.classList.toggle('hidden', configured);
    el.keyStats.classList.toggle('hidden', !configured);
    el.keyMeta.classList.toggle('hidden', !configured);
    el.keyActions.classList.toggle('hidden', !configured);

    // 大数字卡片
    el.statToday.textContent = BFF.formatRice(Number(state.todayRice) || 0);
    const balance = Number(state.balance);
    el.statBalance.textContent = Number.isFinite(balance) && state.balance !== null ? BFF.formatYuan(balance) : '--';

    // 次级信息
    el.statTotal.textContent = BFF.formatRice(Number(state.totalRice) || 0);
    el.statStreak.textContent = String(Math.max(0, Math.floor(Number(state.streakDays) || 0)));
    el.statLastUpdate.textContent = formatClock(state.lastCheckAt);

    // 错误条与气泡
    renderErrorBar(configured);
    el.fishBubble.textContent = buildBubbleText(settings, state);

    updateStatus();
  }

  /**
   * 刷新按钮的 loading 状态（防连点）。
   * @param {boolean} loading
   */
  function setRefreshLoading(loading) {
    if (!el.refreshBtn) return;
    el.refreshBtn.disabled = !!loading;
    el.refreshBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    el.refreshLabel.textContent = loading ? '干饭中…' : '🍚 再吃一口（刷新）';
  }

  /** 显示「本次战果」提示 */
  function showLastGain(riceGained, event) {
    if (!el.lastGain) return;
    const rice = Math.max(0, Number(riceGained) || 0);
    let text = '本次干了 ' + BFF.formatRice(rice) + ' 碗';
    if (event === 'baseline') {
      text = '已记录初始余额，下次消耗就开始记账';
    } else if (event === 'refund') {
      text = '余额变多了，鱼把饭吐出来了';
    } else if (rice <= 0) {
      text = '本次干了 0 碗，鱼在认真摸鱼';
    }
    el.lastGain.textContent = text;
    el.lastGain.classList.remove('hidden');
  }

  /* ================================================================
   * 7. 成就墙渲染
   * ================================================================ */

  /** 单张成就卡：全部文本用 textContent，避免任何注入风险 */
  function buildAchievementCard(achievement, entry) {
    const unlocked = !!entry;
    const card = document.createElement('article');
    card.className = 'ach-card ' + (unlocked ? 'unlocked' : 'locked');
    card.setAttribute('data-achievement-id', achievement.id);

    if (ui.highlightIds.has(achievement.id)) {
      card.classList.add('unlock-flash');
    }

    const emoji = document.createElement('div');
    emoji.className = 'ach-emoji';
    emoji.textContent = unlocked ? achievement.emoji : '❔';

    const name = document.createElement('div');
    name.className = 'ach-name';
    name.textContent = unlocked ? achievement.name : '???';

    const desc = document.createElement('div');
    desc.className = 'ach-desc';
    desc.textContent = unlocked ? achievement.desc : '???';

    card.appendChild(emoji);
    card.appendChild(name);
    card.appendChild(desc);

    if (unlocked) {
      const date = document.createElement('div');
      date.className = 'ach-date';
      const dateText = formatShortDate(entry.unlockedAt);
      date.textContent = dateText ? dateText + ' 解锁' : '已解锁';
      card.appendChild(date);
    } else {
      const condition = document.createElement('div');
      condition.className = 'ach-condition';
      condition.textContent = '解锁条件：' + achievement.condition;
      card.appendChild(condition);
    }

    return card;
  }

  /** 成就墙整体渲染：进度条 + 四个分组 + 2 列卡片 */
  function renderAchievements() {
    if (!el.achGroups) return;
    const achievements = ui.achievements || {};
    const list = Array.isArray(BFF.ACHIEVEMENTS) ? BFF.ACHIEVEMENTS : [];
    const total = list.length || 16;

    let unlockedCount = 0;
    list.forEach(function (achievement) {
      if (achievement && achievements[achievement.id]) unlockedCount += 1;
    });

    el.achCount.textContent = unlockedCount + ' / ' + total;
    const percent = total > 0 ? Math.round((unlockedCount / total) * 100) : 0;
    el.achProgressFill.style.width = percent + '%';
    el.achProgress.setAttribute('aria-valuemax', String(total));
    el.achProgress.setAttribute('aria-valuenow', String(unlockedCount));
    el.achProgress.setAttribute('aria-valuetext', '已解锁 ' + unlockedCount + ' / ' + total);

    // 重新构建分组，先清空旧节点
    el.achGroups.textContent = '';

    GROUP_ORDER.forEach(function (group) {
      const items = list.filter(function (achievement) {
        return achievement && achievement.group === group;
      });
      if (items.length === 0) return;

      let groupUnlocked = 0;
      items.forEach(function (achievement) {
        if (achievements[achievement.id]) groupUnlocked += 1;
      });

      const meta = GROUP_META[group] || { title: '其他成就', emoji: '🏅' };

      const section = document.createElement('section');
      section.className = 'ach-group';

      const title = document.createElement('h3');
      title.className = 'ach-group-title';
      title.textContent = meta.emoji + ' ' + meta.title;

      const count = document.createElement('span');
      count.className = 'ach-group-count';
      count.textContent = groupUnlocked + ' / ' + items.length;

      title.appendChild(count);
      section.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'ach-grid';
      items.forEach(function (achievement) {
        grid.appendChild(buildAchievementCard(achievement, achievements[achievement.id]));
      });

      section.appendChild(grid);
      el.achGroups.appendChild(section);
    });
  }

  /* ================================================================
   * 8. 干饭榜渲染
   * ================================================================ */

  /** 更新时间说明 */
  function formatRankUpdated(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return '';
    return '更新于 ' + formatClock(ts);
  }

  /** loading 骨架屏 */
  function renderRankSkeleton() {
    const card = document.createElement('div');
    card.className = 'skeleton-list card';
    for (let i = 0; i < 6; i += 1) {
      const row = document.createElement('div');
      row.className = 'skeleton-row';

      const rankBar = document.createElement('div');
      rankBar.className = 'skeleton-bar rank';

      const nameBar = document.createElement('div');
      nameBar.className = 'skeleton-bar name';

      const riceBar = document.createElement('div');
      riceBar.className = 'skeleton-bar rice';

      row.appendChild(rankBar);
      row.appendChild(nameBar);
      row.appendChild(riceBar);
      card.appendChild(row);
    }
    el.rankBody.appendChild(card);
  }

  /**
   * 空态 / 失败态。
   * @param {{emoji:string,title:string,desc:string,retry:boolean}} config
   */
  function renderRankState(config) {
    const card = document.createElement('div');
    card.className = 'card state-card';

    const emoji = document.createElement('div');
    emoji.className = 'state-emoji';
    emoji.textContent = config.emoji;

    const title = document.createElement('div');
    title.className = 'state-title';
    title.textContent = config.title;

    const desc = document.createElement('div');
    desc.className = 'state-desc';
    desc.textContent = config.desc;

    card.appendChild(emoji);
    card.appendChild(title);
    card.appendChild(desc);

    if (config.retry) {
      const button = document.createElement('button');
      button.className = 'btn btn-ghost btn-sm';
      button.type = 'button';
      button.textContent = '重新加载';
      button.addEventListener('click', function () {
        loadRank(true);
      });
      card.appendChild(button);
    }

    el.rankBody.appendChild(card);
  }

  /** 榜单列表：前三名金银铜、自己高亮、昵称过长省略号 */
  function renderRankList(ranks, me) {
    const card = document.createElement('div');
    card.className = 'rank-list card';

    const myRank = me && Number.isFinite(Number(me.rank)) ? Number(me.rank) : null;

    ranks.forEach(function (item) {
      const rank = Number(item.rank) || 0;
      const row = document.createElement('div');
      row.className = 'rank-row';
      if (rank >= 1 && rank <= 3) row.classList.add('rank-top-' + rank);

      const isMe = myRank !== null && rank === myRank;
      if (isMe) row.classList.add('rank-me');

      const no = document.createElement('span');
      no.className = 'rank-no';
      if (rank === 1) no.textContent = '🥇';
      else if (rank === 2) no.textContent = '🥈';
      else if (rank === 3) no.textContent = '🥉';
      else no.textContent = rank > 0 ? String(rank) : '—';

      const name = document.createElement('span');
      name.className = 'rank-name';

      const nameText = document.createElement('span');
      nameText.className = 'rank-name-text';
      nameText.textContent = item.nickname || '匿名肥鱼';
      name.appendChild(nameText);

      if (isMe) {
        const tag = document.createElement('span');
        tag.className = 'rank-me-tag';
        tag.textContent = '我';
        name.appendChild(tag);
      }

      const rice = document.createElement('span');
      rice.className = 'rank-rice';
      rice.textContent = BFF.formatRice(item.totalRice) + ' 碗';

      row.appendChild(no);
      row.appendChild(name);
      row.appendChild(rice);
      card.appendChild(row);
    });

    el.rankBody.appendChild(card);
  }

  /** 「我的排名」底部卡片 */
  function renderMyRank(rankData) {
    if (!el.myRankText || !el.myRankValue) return;
    const me = rankData && rankData.me;
    if (me && Number.isFinite(Number(me.rank)) && Number(me.rank) > 0) {
      el.myRankCard.classList.remove('hidden');
      el.myRankText.textContent = '第 ' + Number(me.rank) + ' 名';
      el.myRankValue.classList.remove('my-rank-empty');
      el.myRankValue.textContent = BFF.formatRice(me.totalRice) + ' 碗';
      return;
    }

    // 未上榜：按 SPEC 文案引导回主界面
    el.myRankCard.classList.remove('hidden');
    el.myRankText.textContent = '--';
    el.myRankValue.classList.add('my-rank-empty');
    el.myRankValue.textContent = '还没上榜，去主界面吃一口';
  }

  /** 干饭榜整体渲染 */
  function renderRank() {
    if (!el.rankBody) return;
    const rankData = ui.rankData;
    el.rankBody.textContent = '';

    if (ui.rankLoading) {
      el.rankUpdated.textContent = '榜单加载中…';
      renderRankSkeleton();
      renderMyRank(rankData);
      return;
    }

    if (ui.rankError) {
      el.rankUpdated.textContent = '';
      renderRankState({
        emoji: '🌐',
        title: '榜单加载失败',
        desc: ui.rankError,
        retry: true
      });
      renderMyRank(rankData);
      return;
    }

    if (!rankData || !Array.isArray(rankData.ranks)) {
      el.rankUpdated.textContent = '';
      renderRankState({
        emoji: '🍚',
        title: '还没拉取榜单',
        desc: '点右上角「刷新」，看看大家今天干了多少碗。',
        retry: true
      });
      renderMyRank(rankData);
      return;
    }

    if (rankData.ranks.length === 0) {
      el.rankUpdated.textContent = formatRankUpdated(rankData.fetchedAt);
      renderRankState({
        emoji: '🫙',
        title: '榜单空空如也',
        desc: '还没有人上榜，来当第一个干饭王吧！',
        retry: true
      });
      renderMyRank(rankData);
      return;
    }

    el.rankUpdated.textContent = formatRankUpdated(rankData.fetchedAt);
    renderRankList(rankData.ranks, rankData.me);
    renderMyRank(rankData);
  }

  /** 设置排行榜刷新按钮的 loading 状态 */
  function setRankLoading(loading) {
    if (!el.rankRefreshBtn) return;
    el.rankRefreshBtn.disabled = !!loading;
    el.rankRefreshBtn.textContent = loading ? '加载中…' : '🔄 刷新';
  }

  /**
   * 进入干饭榜时的加载入口：
   *  - 60 秒内的内存 / 本地缓存直接复用，不重复请求；
   *  - force=true 时强制拉取（用户点刷新）。
   */
  function ensureRankLoaded(force) {
    if (ui.rankLoading) return;
    if (!force && ui.rankData && Date.now() - ui.rankLoadedAt < RANK_CACHE_TTL) {
      renderRank();
      return;
    }
    loadRank(!!force);
  }

  /** 真正请求排行榜（唯一会发网络请求的榜单入口） */
  async function loadRank(force) {
    if (ui.rankLoading) return;

    // 首次进入：先尝试本地缓存（BFF.refreshRank 成功时会顺手写入）
    if (!force && !ui.rankData) {
      try {
        const cache = await BFF.loadRankCache();
        if (cache && Array.isArray(cache.ranks) && Date.now() - Number(cache.fetchedAt || 0) < RANK_CACHE_TTL) {
          ui.rankData = {
            ok: true,
            ranks: cache.ranks,
            me: cache.me || null,
            fetchedAt: Number(cache.fetchedAt) || Date.now()
          };
          ui.rankLoadedAt = Date.now();
          renderRank();
          return;
        }
      } catch (error) {
        console.warn('[大肥鱼] 读取榜单缓存失败：', error);
      }
    }

    ui.rankLoading = true;
    ui.rankError = '';
    setRankLoading(true);
    renderRank();

    try {
      const settings = ui.settings || BFF.DEFAULT_SETTINGS;
      const state = ui.state || {};
      const result = await BFF.refreshRank({
        apiBase: settings.apiBase,
        deviceId: state.deviceId,
        limit: RANK_LIMIT
      });

      if (result && result.ok) {
        ui.rankData = result;
        ui.rankLoadedAt = Date.now();
        ui.rankError = '';
      } else {
        ui.rankError = messageFor(result && result.code, result && result.message);
      }
    } catch (error) {
      console.warn('[大肥鱼] 加载排行榜失败：', error);
      ui.rankError = '榜单加载失败，请稍后再试';
    } finally {
      ui.rankLoading = false;
      setRankLoading(false);
      renderRank();
    }
  }

  /* ================================================================
   * 9. 设置面板
   * ================================================================ */

  /**
   * 把当前设置写回表单。
   * @param {boolean} force true 时覆盖用户正在编辑的内容（保存 / 清空后使用）
   */
  function renderSettingsForm(force) {
    if (!el.apiKeyInput) return;
    if (!force && ui.settingsDirty) return;

    const settings = ui.settings || BFF.DEFAULT_SETTINGS;
    el.apiKeyInput.value = settings.apiKey || '';
    el.nicknameInput.value = settings.nickname || BFF.DEFAULT_SETTINGS.nickname;
    el.syncToggle.checked = settings.syncEnabled !== false;
    el.refreshSelect.value = String(selectRefreshMinutes(settings.refreshMinutes));
    el.apiBaseInput.value = settings.apiBase || BFF.DEFAULT_SETTINGS.apiBase;

    // 每次回填都重置 API Key 的显示状态，避免明文一直挂着
    el.apiKeyInput.type = 'password';
    el.toggleKeyBtn.textContent = '👁️';
    el.toggleKeyBtn.setAttribute('aria-pressed', 'false');
    el.toggleKeyBtn.setAttribute('aria-label', '显示 API Key');

    ui.settingsDirty = false;
  }

  /** API Key 显示 / 隐藏 */
  function toggleKeyVisibility() {
    const isPassword = el.apiKeyInput.type === 'password';
    el.apiKeyInput.type = isPassword ? 'text' : 'password';
    el.toggleKeyBtn.textContent = isPassword ? '🙈' : '👁️';
    el.toggleKeyBtn.setAttribute('aria-pressed', isPassword ? 'true' : 'false');
    el.toggleKeyBtn.setAttribute('aria-label', isPassword ? '隐藏 API Key' : '显示 API Key');
  }

  /** 随机昵称：避开当前输入框里的名字 */
  function randomNickname() {
    const current = el.nicknameInput.value.trim();
    const pool = RANDOM_NICKNAMES.filter(function (name) {
      return name !== current;
    });
    const source = pool.length > 0 ? pool : RANDOM_NICKNAMES;
    return source[Math.floor(Math.random() * source.length)] || '匿名肥鱼';
  }

  /** 显示测试连接结果行 */
  function showTestResult(text, isError) {
    if (!el.testResult) return;
    el.testResult.textContent = String(text);
    el.testResult.classList.remove('hidden');
    el.testResult.classList.toggle('is-error', !!isError);
  }

  /** 隐藏测试连接结果行 */
  function hideTestResult() {
    if (!el.testResult) return;
    el.testResult.classList.add('hidden');
    el.testResult.textContent = '';
    el.testResult.classList.remove('is-error');
  }

  /**
   * 保存设置：
   *  - 昵称按 Unicode 截断、地址去掉尾部斜杠，均与 shared.js / 后端规则保持一致；
   *  - 保存成功后通知 Service Worker 按新间隔重建 alarm。
   */
  async function handleSaveSettings() {
    if (ui.saving) return;
    ui.saving = true;
    el.saveSettingsBtn.disabled = true;

    try {
      const nickname = truncateNickname(el.nicknameInput.value.trim() || BFF.DEFAULT_SETTINGS.nickname);
      const apiBase = (el.apiBaseInput.value.trim() || BFF.DEFAULT_SETTINGS.apiBase).replace(/\/+$/, '');

      const saved = await BFF.saveSettings({
        apiKey: el.apiKeyInput.value.trim(),
        nickname: nickname,
        syncEnabled: !!el.syncToggle.checked,
        refreshMinutes: selectRefreshMinutes(el.refreshSelect.value),
        apiBase: apiBase
      });

      ui.settings = saved;
      ui.settingsDirty = false;
      renderSettingsForm(true);
      renderHome();
      updateStatus(saved.apiKey ? 'configured' : 'unconfigured');
      showToast('设置已保存', { emoji: '✅', desc: '大肥鱼记住了你的口味。' });

      // 无论间隔是否变化都重建一次 alarm：幂等操作，避免用户改完间隔后后台仍用旧周期
      try {
        const response = await chrome.runtime.sendMessage({ type: 'BFF_ALARM_RESET' });
        if (!response || response.ok !== true) {
          console.warn('[大肥鱼] 后台未确认闹钟重建：', response);
        }
      } catch (error) {
        console.warn('[大肥鱼] 通知后台重建闹钟失败：', error);
      }
    } catch (error) {
      console.warn('[大肥鱼] 保存设置失败：', error);
      showToast('保存失败', { emoji: '😵', type: 'error', desc: '请稍后再试一次。' });
    } finally {
      ui.saving = false;
      el.saveSettingsBtn.disabled = false;
    }
  }

  /** 测试连接：直接调用 BFF.fetchBalance，不经过刷新流程、不写 state */
  async function handleTestConnection() {
    if (ui.testing) return;
    const apiKey = el.apiKeyInput.value.trim();

    if (!apiKey) {
      showTestResult('❌ 先填 API Key 再测试', true);
      showToast('先填 API Key', { emoji: '🔑', desc: '没有 Key 大肥鱼测不了余额。' });
      return;
    }

    ui.testing = true;
    const originalText = el.testConnBtn.textContent;
    el.testConnBtn.disabled = true;
    el.testConnBtn.textContent = '🔌 测试中…';
    hideTestResult();

    try {
      const result = await BFF.fetchBalance(apiKey);
      if (result && result.ok) {
        const text = '✅ 连接成功，余额 ' + BFF.formatYuan(result.totalBalance) + ' 元';
        showTestResult(text, false);
        showToast(text, { emoji: '✅', desc: 'Key 有效，可以开饭了。' });
      } else {
        const message = messageFor(result && result.code, result && result.message);
        showTestResult('❌ ' + message, true);
        showToast('连接失败', { emoji: '😵', type: 'error', desc: message });
      }
    } catch (error) {
      console.warn('[大肥鱼] 测试连接失败：', error);
      showTestResult('❌ 测试连接时发生未知错误', true);
    } finally {
      ui.testing = false;
      el.testConnBtn.disabled = false;
      el.testConnBtn.textContent = originalText;
    }
  }

  /** 清空本地数据：二次确认后清空并重新加载全部 UI */
  async function handleClearData() {
    if (ui.clearing) return;
    const confirmed = window.confirm('确定要清空全部本地数据吗？\n设置、余额记录、成就、榜单缓存都会被删除，且无法恢复。');
    if (!confirmed) return;

    ui.clearing = true;
    el.clearDataBtn.disabled = true;

    try {
      await BFF.clearAllData();

      // 内存态全部重置
      ui.rankData = null;
      ui.rankLoadedAt = 0;
      ui.rankError = '';
      ui.highlightIds.clear();
      ui.dismissedErrorAt = 0;
      ui.settingsDirty = false;

      await refreshLocalData(true);
      renderRank();
      switchTab('home');
      showToast('本地数据已清空', { emoji: '🧹', desc: '大肥鱼重新投胎了。' });
    } catch (error) {
      console.warn('[大肥鱼] 清空数据失败：', error);
      showToast('清空失败', { emoji: '😵', type: 'error', desc: '请稍后再试一次。' });
    } finally {
      ui.clearing = false;
      el.clearDataBtn.disabled = false;
    }
  }

  /* ================================================================
   * 10. Tab / 设置面板切换
   * ================================================================ */

  /** 切换业务 Tab */
  function switchTab(tabKey) {
    if (TAB_KEYS.indexOf(tabKey) < 0) return;
    ui.activeTab = tabKey;
    ui.settingsOpen = false;

    el.tabbar.classList.remove('hidden');
    const tabButtons = el.tabbar.querySelectorAll('.tab');
    for (let i = 0; i < tabButtons.length; i += 1) {
      const button = tabButtons[i];
      const active = button.getAttribute('data-tab') === tabKey;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    TAB_KEYS.forEach(function (key) {
      const panel = $id('panel-' + key);
      if (panel) panel.classList.toggle('active', key === tabKey);
    });

    const settingsPanel = $id('panel-settings');
    if (settingsPanel) settingsPanel.classList.remove('active');

    if (el.main) el.main.scrollTop = 0;

    // 首次进入排行榜时自动加载；60 秒缓存由 ensureRankLoaded 控制
    if (tabKey === 'rank') ensureRankLoaded(false);
    if (tabKey === 'achievements') renderAchievements();
  }

  /** 打开设置面板（隐藏 Tab 栏，返回时恢复） */
  function openSettings() {
    ui.settingsOpen = true;
    renderSettingsForm(true);

    el.tabbar.classList.add('hidden');
    TAB_KEYS.forEach(function (key) {
      const panel = $id('panel-' + key);
      if (panel) panel.classList.remove('active');
    });

    const settingsPanel = $id('panel-settings');
    if (settingsPanel) settingsPanel.classList.add('active');
    if (el.main) el.main.scrollTop = 0;
  }

  /* ================================================================
   * 11. 数据读取 / 刷新流程
   * ================================================================ */

  /**
   * 从 storage 重新读取三份数据，并重绘整个 UI。
   * @param {boolean} forceSettings 是否强制回填设置表单
   */
  async function refreshLocalData(forceSettings) {
    try {
      const results = await Promise.all([
        BFF.loadSettings(),
        BFF.loadState(),
        BFF.loadAchievements()
      ]);
      ui.settings = results[0];
      ui.state = results[1];
      ui.achievements = results[2] || {};
    } catch (error) {
      console.warn('[大肥鱼] 读取本地数据失败：', error);
    }
    renderAll(forceSettings);
  }

  /** 全套渲染：设置表单 + 首页 + 成就墙 + 榜单 + Header 状态 */
  function renderAll(forceSettings) {
    renderSettingsForm(!!forceSettings);
    renderHome();
    renderAchievements();
    renderRank();
    updateStatus();
  }

  /** 把刷新结果里的新数据先吸收进内存，后续统一从 storage 重读 */
  function absorbRefreshResult(result) {
    if (!result) return;
    if (result.settings) ui.settings = result.settings;
    if (result.state) ui.state = result.state;
    if (result.achievements) ui.achievements = result.achievements;
  }

  /** 刷新失败时的统一展示：错误条 + Toast（NO_KEY 改为引导） */
  function handleRefreshFailure(result) {
    const code = result && result.code ? result.code : 'UNKNOWN';
    const message = messageFor(code, result && result.message);

    if (code === 'NO_KEY') {
      ui.settings = Object.assign({}, ui.settings || {}, { apiKey: '' });
      renderHome();
      showToast('还没填 API Key', { emoji: '🔑', desc: '打开设置填一把，大肥鱼就开饭了。' });
      openSettings();
      return;
    }

    showErrorBar(message);
    renderHome();
    showToast('刷新失败', { emoji: '🥣', type: 'error', desc: message });
  }

  /** 刷新成功后的统一收尾：战果提示 + 成就 Toast + 数据重读 */
  async function finishRefreshSuccess(result, options) {
    const opts = options || {};
    ui.dismissedErrorAt = 0;
    hideErrorBar();

    const riceGained = Number(result.riceGained) || 0;
    const event = result.event || '';

    if (!opts.silent || riceGained > 0 || event === 'baseline') {
      showLastGain(riceGained, event);
    }

    // 展示后台 / 本次刷新攒下的成就 Toast
    await flushPendingToasts();

    // 最终以 storage 里的落盘数据为准重绘
    await refreshLocalData(false);

    // 榜单缓存标记为过期：下次进入榜单会重新拉取（避免显示旧名次）
    if (ui.rankData) ui.rankLoadedAt = 0;
    if (ui.activeTab === 'rank') ensureRankLoaded(true);

    if (!opts.silent && result.message) {
      showToast('🍚 ' + result.message, { emoji: '🍚' });
    }
  }

  /**
   * 手动刷新（主按钮 / 后台消息入口共用）。
   * @param {'manual'|'popup'|'alarm'} trigger
   */
  async function runRefresh(trigger) {
    if (ui.refreshing) return;

    const settings = ui.settings || BFF.DEFAULT_SETTINGS;
    if (!settings.apiKey) {
      showToast('还没填 API Key', { emoji: '🔑', desc: '打开设置填一把，大肥鱼就开饭了。' });
      openSettings();
      return;
    }

    ui.refreshing = true;
    setRefreshLoading(true);
    updateStatus('loading');
    if (el.lastGain) el.lastGain.classList.add('hidden');

    try {
      const result = await BFF.refreshAll({ trigger: trigger || 'manual' });
      absorbRefreshResult(result);

      if (!result || !result.ok) {
        handleRefreshFailure(result);
        return;
      }

      await finishRefreshSuccess(result, { silent: false });
    } catch (error) {
      console.warn('[大肥鱼] 刷新失败：', error);
      showErrorBar('刷新时出现未知错误，请稍后再试');
      showToast('刷新失败', { emoji: '💥', type: 'error', desc: '出现未知错误，请稍后再试。' });
    } finally {
      ui.refreshing = false;
      setRefreshLoading(false);
      updateStatus();
    }
  }

  /** Popup 打开时的静默刷新：失败不弹成就、不打扰用户，只更新界面 */
  async function refreshSilently() {
    if (ui.refreshing) return;
    if (!ui.settings || !ui.settings.apiKey) {
      updateStatus('unconfigured');
      return;
    }

    ui.refreshing = true;
    setRefreshLoading(true);
    updateStatus('loading');

    try {
      const result = await BFF.refreshAll({ trigger: 'popup' });
      absorbRefreshResult(result);

      if (!result || !result.ok) {
        const code = result && result.code ? result.code : 'UNKNOWN';
        if (code !== 'NO_KEY') {
          showErrorBar(messageFor(code, result && result.message));
        }
        renderHome();
        return;
      }

      await finishRefreshSuccess(result, { silent: true });
    } catch (error) {
      console.warn('[大肥鱼] 静默刷新失败：', error);
      showErrorBar('自动刷新失败，请稍后再试');
    } finally {
      ui.refreshing = false;
      setRefreshLoading(false);
      updateStatus();
    }
  }

  /* ================================================================
   * 12. storage.onChanged：只重渲染，不重复请求
   * ================================================================ */

  function registerStorageListener() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;

    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local') return;
      const stateKey = BFF.STORAGE_KEYS.state;
      const achievementsKey = BFF.STORAGE_KEYS.achievements;
      if (!changes[stateKey] && !changes[achievementsKey]) return;
      scheduleRenderFromStorage();
    });
  }

  /** 防抖：后台可能连续写 state / achievements，合并成一次重绘 */
  function scheduleRenderFromStorage() {
    if (ui.renderTimer) return;
    ui.renderTimer = window.setTimeout(async function () {
      ui.renderTimer = 0;
      try {
        const results = await Promise.all([BFF.loadState(), BFF.loadAchievements()]);
        ui.state = results[0];
        ui.achievements = results[1] || {};

        // 关键：这里只重绘，绝不调用 refreshAll / refreshRank，避免死循环
        renderHome();
        renderAchievements();
        renderMyRank(ui.rankData);
        updateStatus();
      } catch (error) {
        console.warn('[大肥鱼] storage 变化后重绘失败：', error);
      }
    }, 120);
  }

  /* ================================================================
   * 13. 事件绑定与初始化
   * ================================================================ */

  function bindEvents() {
    // Tab 切换
    const tabButtons = el.tabbar.querySelectorAll('.tab');
    for (let i = 0; i < tabButtons.length; i += 1) {
      const button = tabButtons[i];
      button.addEventListener('click', function () {
        switchTab(button.getAttribute('data-tab'));
      });
    }

    // Header 设置齿轮：设置面板已经打开时再次点击等于「返回」
    el.settingsBtn.addEventListener('click', function () {
      if (ui.settingsOpen) {
        switchTab(ui.activeTab);
      } else {
        openSettings();
      }
    });
    el.settingsBackBtn.addEventListener('click', function () {
      switchTab(ui.activeTab);
    });

    // 首页
    el.goSettingsBtn.addEventListener('click', openSettings);
    el.refreshBtn.addEventListener('click', function () {
      runRefresh('manual');
    });
    el.errorClose.addEventListener('click', function () {
      const state = ui.state || {};
      const lastError = state.lastError;
      ui.dismissedErrorAt = lastError && Number(lastError.at) ? Number(lastError.at) : Date.now();
      hideErrorBar();
    });

    // 设置
    el.toggleKeyBtn.addEventListener('click', toggleKeyVisibility);
    el.randomNickBtn.addEventListener('click', function () {
      el.nicknameInput.value = randomNickname();
      ui.settingsDirty = true;
    });
    el.saveSettingsBtn.addEventListener('click', handleSaveSettings);
    el.testConnBtn.addEventListener('click', handleTestConnection);
    el.clearDataBtn.addEventListener('click', handleClearData);

    // 用户改动设置表单时打上 dirty 标记，避免 storage 变化冲掉输入
    const settingsInputs = [el.apiKeyInput, el.nicknameInput, el.refreshSelect, el.apiBaseInput];
    settingsInputs.forEach(function (input) {
      input.addEventListener('input', function () {
        ui.settingsDirty = true;
      });
    });
    el.syncToggle.addEventListener('change', function () {
      ui.settingsDirty = true;
    });
    el.refreshSelect.addEventListener('change', function () {
      ui.settingsDirty = true;
    });

    // 排行榜刷新
    el.rankRefreshBtn.addEventListener('click', function () {
      ensureRankLoaded(true);
    });
  }

  /** 初始化：缓存 DOM → 读数据 → 渲染 → 监听 → 静默刷新 */
  async function init() {
    cacheDom();
    bindEvents();

    await refreshLocalData(true);
    registerStorageListener();

    // Popup 打开先把后台定时刷新攒下的成就 Toast 弹掉
    await flushPendingToasts();

    // 已配置 Key 时静默刷新一次（完成后会再重绘 + 展示新成就）
    if (ui.settings && ui.settings.apiKey) {
      await refreshSilently();
    } else {
      updateStatus('unconfigured');
    }
  }

  function boot() {
    init().catch(function (error) {
      console.warn('[大肥鱼] Popup 初始化失败：', error);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
