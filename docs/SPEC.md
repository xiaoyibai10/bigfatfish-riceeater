# 大肥鱼的白饭日记 · 开发契约（SPEC）

> 本文件是团队协作的唯一事实来源。所有实现必须严格遵守本文件定义的路径、数据结构、接口与行为。
> 仓库根目录：`D:\DSH工作目录\bigfatfish-riceeater`
> 编码：UTF-8（无 BOM）、LF；文案全部中文；代码注释必须为详细中文注释。
> 硬性要求：**禁止出现 `...` 之类的省略占位**，每个文件必须完整可运行。

## 0. 产品一句话

读取 DeepSeek API 余额，把消耗的人民币换算成「白饭」（**0.1 元 = 1 碗**），配上赛博干饭人成就墙与匿名排行榜。Chrome MV3 原生扩展（无构建）+ Vercel Serverless + Supabase。

## 1. 目录结构（必须一致）

```
bigfatfish-riceeater/
├── extension/                     # Chrome 扩展，直接「加载已解压的扩展程序」
│   ├── manifest.json              # MV3
│   ├── popup.html                 # 主界面 + 成就墙 + 干饭榜 + 设置 + 内联 CSS
│   ├── popup.js                   # UI 渲染 / 交互 / Toast
│   ├── shared.js                  # 共享核心逻辑（Lead 实现，其他人只读）
│   ├── background.js              # Service Worker + chrome.alarms
│   ├── assets/
│   │   ├── deepseek-chibi.webp        # 完整立绘：主界面展示
│   │   ├── deepseek-chibi-avatar.webp # 圆形头像：Header / 图标输入
│   │   └── ATTRIBUTION.md             # 素材来源与授权说明
│   └── icons/
│       ├── icon16.png                 # 由头像生成
│       ├── icon32.png
│       ├── icon48.png
│       └── icon128.png
├── api/
│   ├── rank/
│   │   ├── update.js              # POST /api/rank/update
│   │   └── top.js                 # GET  /api/rank/top
│   └── _lib/
│       ├── supabase.js            # Supabase 客户端单例
│       ├── http.js                # CORS / JSON / 请求体解析
│       └── validate.js            # 入参校验
├── supabase/
│   └── schema.sql                 # 建表 + 防作弊 RPC + RLS/权限
├── tests/
│   └── logic.test.js              # Lead 编写，node tests/logic.test.js
├── scripts/
│   └── make_icons.py              # Lead 图标生成脚本
├── package.json                   # 后端依赖与 test 脚本
├── vercel.json
├── .env.example
├── .gitignore
├── README.md
└── LICENSE
```

## 2. 术语与常量

- `RICE_PER_YUAN = 10`，`PRICE_PER_BOWL = 0.1`。
- 金额内部以「元」存储并保留 2 位小数；白饭累计保留 1 位小数（`round1`）。
- 时间：毫秒时间戳存 storage；「日期」一律用**本地时区** `YYYY-MM-DD`（`dateKey`）。
- DeepSeek 余额接口：`GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <API_KEY>`。
  返回示例：`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}`。
  解析规则：优先取 `currency === "CNY"`，否则取第一条；`total_balance` 为字符串，需 `Number()`。

## 3. `extension/shared.js`（Lead 所有，只读契约）

挂载到 `globalThis.BFF`，同时被 Popup 与 Service Worker 使用（`background.js` 用 `importScripts('shared.js')`）。
**不得依赖 DOM**；仅允许 `chrome.storage.local`、`fetch`、`crypto`。

### 3.1 常量

```js
BFF.VERSION              // '1.0.0'
BFF.RICE_PER_YUAN        // 10
BFF.PRICE_PER_BOWL       // 0.1
BFF.STORAGE_KEYS         // { settings:'bff_settings', state:'bff_state', achievements:'bff_achievements', rankCache:'bff_rank_cache' }
BFF.DEFAULT_SETTINGS     // { apiKey:'', nickname:'匿名肥鱼', syncEnabled:true, refreshMinutes:30, apiBase:'https://bigfatfish-riceeater.vercel.app' }
BFF.ACHIEVEMENTS         // 16 个成就的元数据数组（见 §4），每项 {id,group,name,emoji,condition,desc}
```

### 3.2 存储结构

`bff_settings`：

```js
{ apiKey:'sk-...', nickname:'匿名肥鱼', syncEnabled:true, refreshMinutes:30, apiBase:'https://xxx.vercel.app' }
```

`bff_state`：

```js
{
  deviceId: '<uuid>',          // crypto.randomUUID()
  balance: null,               // 当前余额（元，number）
  totalSpent: 0,               // 累计消耗（元，2 位小数）
  totalRice: 0,                // 累计白饭（碗 = totalSpent * 10，1 位小数）
  todayDate: '',               // 'YYYY-MM-DD'
  todayRice: 0,                // 今日白饭（碗）
  streakDays: 0,               // 连续有消耗的天数
  lastEatDate: '',             // 最近一次有消耗的日期
  lastEatAt: 0,                // 最近一次有消耗的时间戳
  maxSingleSpend: 0,           // 单次刷新最大消耗（元）
  balanceIncreaseCount: 0,     // 余额增加的次数（退款/退订）
  lastCheckAt: 0,
  lastCheckStatus: 'idle',     // 'idle' | 'ok' | 'error'
  lastError: null,             // { code, message, at }
  baselineAt: 0,               // 首次记录余额的时间
  joinedRank: false,
  rankBest: null,              // 历史最好名次（number|null）
  rankIsFirst: false,
  lastSyncAt: 0,
  lastSyncedRice: 0,
  lastSyncStatus: 'idle',      // 'idle' | 'ok' | 'rejected' | 'error' | 'throttled'
  lastSyncError: null,         // { code, message, at }
  syncCooldownUntil: 0,
  pendingToasts: [],           // 待展示成就 [{id,name,emoji,desc,unlockedAt}]
  firstRunAt: 0
}
```

`bff_achievements`：`{ [achievementId]: { unlockedAt: number } }`
`bff_rank_cache`：`{ fetchedAt:number, ranks:[{rank,nickname,totalRice}], me:null|{rank,nickname,totalRice} }`

### 3.3 函数（返回值必须与这里一致）

```js
// 存储
BFF.loadSettings()                 -> Promise<Settings>            // 已归一化，缺字段补默认值
BFF.saveSettings(patch)            -> Promise<Settings>            // 合并 + 归一化后写入
BFF.loadState()                    -> Promise<State>               // 已补齐默认值、滚动今日数据
BFF.saveState(state)               -> Promise<void>
BFF.loadAchievements()             -> Promise<{[id]:{unlockedAt}}>
BFF.clearAllData()                 -> Promise<void>                // 移除三个 key

// 网络
BFF.fetchBalance(apiKey)           -> Promise<{ok:true, totalBalance:number, currency:string, isAvailable:boolean, raw:object}
                                              | {ok:false, code:'NO_KEY'|'AUTH'|'NETWORK'|'TIMEOUT'|'API'|'PARSE'|'HTTP', message:string, status?:number}>
BFF.syncRank({deviceId,nickname,totalRice,apiBase}) -> Promise<{ok:true, rank:number, totalRice:number}
                                                              | {ok:false, rejected:boolean, code:string, message:string, retryAfterSeconds?:number}>
BFF.fetchTop({apiBase,deviceId,limit}) -> Promise<{ok:true,ranks,me,fetchedAt}
                                              | {ok:false, code, message}>
BFF.refreshRank({apiBase,deviceId,limit}) -> Promise<same as fetchTop>  // 成功时顺手写 rankCache

// 纯逻辑
BFF.applyBalance(state, balanceInfo, now)  -> { state, spent, riceGained, event:'baseline'|'spend'|'refund'|'none' }
BFF.evaluateAchievements(state, achievements, ctx) -> { achievements, newlyUnlocked:[{id,group,name,emoji,condition,desc,unlockedAt}] }
    // ctx = { now?:number, rank?:number|null, joinedRank?:boolean }
BFF.recordSyncResult(state, syncResult, now) -> state              // 返回新 state
BFF.consumePendingToasts()         -> Promise<Array>               // 读取并清空 pendingToasts

// 编排（Popup 与 SW 共用）
BFF.refreshAll({ trigger?:'popup'|'alarm'|'manual', forceSync?:boolean })
   -> Promise<{
        ok:boolean, code:'OK'|'NO_KEY'|'AUTH'|'NETWORK'|'TIMEOUT'|'API'|'PARSE'|'HTTP'|'SERVER',
        message?:string,
        state:State, settings:Settings, achievements:object,
        newlyUnlocked:Array, spent:number, riceGained:number,
        balance:number|null, sync:object|null
      }>
BFF.formatRice(n)                  -> string                       // 12 -> '12'，12.5 -> '12.5'
BFF.formatYuan(n)                  -> string                       // 110 -> '110.00'
BFF.dateKey(ts)                    -> 'YYYY-MM-DD'
```

### 3.4 `refreshAll` 行为（必须）

1. 读 settings / state / achievements；无 `apiKey` → `{ok:false, code:'NO_KEY'}`（不写 storage）。
2. `fetchBalance` 失败 → 更新 `lastCheckStatus='error'`、`lastError`、`lastCheckAt`，保存 state，返回失败；**不清空已有余额**。
3. 成功 → `applyBalance`；写 `lastCheckStatus='ok'`、`lastError=null`、`lastCheckAt=now`。
4. `evaluateAchievements`，把新解锁项追加到 `state.pendingToasts`（上限 20），保存 achievements。
5. `syncEnabled && totalRice>0` 时同步排行榜：
   - `lastSyncAt` 距今 < 15s 且非 `forceSync` → 跳过（`lastSyncStatus='throttled'`）；
   - `syncCooldownUntil > now` → 跳过；
   - 成功/被拒/失败均 `recordSyncResult`；被拒时 `syncCooldownUntil = now + 5min`；
   - 同步成功后用 `rank` 再评估一次排行榜成就（合并 `newlyUnlocked`）。
6. 保存 state；返回 `ok:true`、`spent`、`riceGained`、`balance`、`sync`。
7. 并发写保护：`saveState` 前重新读取最新 state 只合并本次改动的字段过于复杂，允许「后写覆盖」，但**保存必须串行化**（模块内 Promise 队列）。

### 3.5 `applyBalance` 规则

- 首次（`state.balance == null`）：仅记录余额与 `baselineAt`，不产生消耗，`event='baseline'`。
- `delta = prevBalance - newBalance`（`round2`）：
  - `delta > 0.004` → 消耗：`totalSpent += delta`，`totalRice = round1(totalSpent*10)`，`todayRice += round1(delta*10)`，`maxSingleSpend = max(...)`，连吃更新（见下），`event='spend'`，`spent=delta`，`riceGained=round1(delta*10)`。
  - `delta < -0.004` → 退款：`balanceIncreaseCount++`，不增加白饭，`event='refund'`。
  - 否则 `event='none'`。
- **连吃天数**：若 `lastEatDate === today` 不变；若 `lastEatDate === 昨天` 则 `streakDays += 1`；否则 `streakDays = 1`；并更新 `lastEatDate=today`、`lastEatAt=now`（`streakDays` 至少为 1）。
- 跨天：`todayDate !== today` 时先把 `todayDate=today`、`todayRice=0` 再累加。
- 任何情况下都更新 `balance = newBalance`。

### 3.6 成就判定

- 财富：`totalRice >= threshold`（1/50/200/1000/5000/10000 碗）。
- 连吃：`streakDays >= 3/7/30`。
- 濒死：`balance != null && balance < 1`。
- 冬眠：`lastEatDate` 非空且距今天数 `>= 3`（按日期差，不看时刻）。
- 暴饮暴食：`maxSingleSpend > 10`（严格大于）。
- 赛博减肥：`balanceIncreaseCount >= 1`。
- 鱼苗：`ctx.joinedRank || state.joinedRank`。
- 深海巨物：`ctx.rank<=3` 或 `state.rankBest<=3`。
- 鱼王：`ctx.rank===1` 或 `state.rankIsFirst`。
- 已解锁的不再解锁；`unlockedAt = now`；只返回本次新增。

## 4. 成就目录（16 个，id 固定）

| id | 分组 | Emoji | 名称 | 条件 | 文案 |
|---|---|---|---|---|---|
| `wealth_rookie` | wealth | 🥣 | 讨饭萌新 | 累计 1 碗 | 大肥鱼探出了头，小心翼翼地尝了一口。 |
| `wealth_killer` | wealth | 🥢 | 白饭杀手 | 累计 50 碗 | 平平淡淡才是真，白饭管饱就行。 |
| `wealth_chicken` | wealth | 🍱 | 加个鸡腿 | 累计 200 碗 | 光吃白饭太干了，给自己加个鸡腿吧！ |
| `wealth_feast` | wealth | 🍲 | 满汉全席 | 累计 1000 碗 | 大肥鱼已经进化成了大肥猪，吃穿不愁。 |
| `wealth_bucket` | wealth | 👑 | 赛博饭桶 | 累计 5000 碗 | 老板，再来一桶！这鱼疯了！ |
| `wealth_blackhole` | wealth | 🌌 | 黑洞吞噬者 | 累计 10000 碗 | 连光都无法逃离大肥鱼的胃。 |
| `streak_three` | streak | 🌱 | 一日三餐 | 连续 3 天 | 大肥鱼学会了定点进食。 |
| `streak_seven` | streak | 🔥 | 干饭劳模 | 连续 7 天 | 风雨无阻，哪怕报错也要吃白饭。 |
| `streak_thirty` | streak | ⏳ | 海枯石烂 | 连续 30 天 | 这鱼是把工位搬到食堂了吗？ |
| `special_near_death` | special | 💸 | 濒死体验 | 余额 < 1 元 | 大肥鱼饿得翻白眼了，快充值！ |
| `special_hibernation` | special | 🛌 | 吃饱就睡 | 连续 3 天未消耗 | 大肥鱼进入了冬眠。 |
| `special_binge` | special | 🌪️ | 暴饮暴食 | 单次消耗 > 10 元 | 一口气吃下 100 碗！你拿我当牛使呢？ |
| `special_diet` | special | 📉 | 赛博减肥 | 余额变多 | 吃进去的白饭还能吐出来？医学奇迹！ |
| `rank_fry` | rank | 🐟 | 鱼苗 | 参与排行榜 | 饭桶里的一粒米。 |
| `rank_whale` | rank | 🐳 | 深海巨物 | 榜单前三 | 让一让，大肥鱼来清场了。 |
| `rank_king` | rank | 🏆 | 鱼王 | 榜单第一 | 整个服务器的白饭，由我一人承包！ |

成就元数据项：`{ id, group:'wealth'|'streak'|'special'|'rank', name, emoji, condition, desc }`，`condition` 用于 UI 展示，例如 `'累计干饭 50 碗'`、`'连续干饭 3 天'`、`'余额低于 1 元'`、`'单次消耗超过 10 元'`、`'连续 3 天没吃上饭'`、`'余额神秘增加'`、`'上榜即得'`、`'冲进榜单前三'`、`'登顶榜单第一'`。

## 5. 后端 API 契约

Base：`https://<你的项目>.vercel.app`。全部 JSON；`Access-Control-Allow-Origin: *`；`OPTIONS` 返回 204。
CORS 允许方法 `GET, POST, OPTIONS`，允许头 `Content-Type`。

### 5.1 `POST /api/rank/update`

请求：`{ "deviceId":"<uuid v4>", "nickname":"匿名肥鱼", "totalRice": 123.4 }`

校验：

- `deviceId` 必须匹配 `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`；
- `nickname`：`trim()` 后 1–20 字符（按 Unicode 字符计），过滤控制字符，空则 `匿名肥鱼`；
- `totalRice`：有限数字，`0 <= x <= 10_000_000`，四舍五入到 1 位小数；
- 请求体 ≤ 4KB，非法 JSON → 400。

成功：

```json
{ "ok": true, "rejected": false, "rank": 12, "totalRice": 123.4, "nickname": "匿名肥鱼" }
```

被防作弊拦截（HTTP 200，便于客户端展示）：

```json
{ "ok": false, "rejected": true, "reason": "RATE_LIMIT", "message": "5 分钟内白饭暴增超过 500 碗，本次成绩已被没收。", "retryAfterSeconds": 237 }
```

错误：`400 INVALID_DEVICE_ID | INVALID_TOTAL_RICE | INVALID_JSON | PAYLOAD_TOO_LARGE`，
`405 METHOD_NOT_ALLOWED`，`500 CONFIG_MISSING | DB_ERROR`，`504 SUPABASE_TIMEOUT`（实现以 `api/rank/update.js` 为准）。

防作弊规则（数据库 RPC 内原子完成）：同一 `device_id` 上次上报后 **5 分钟内**，若本次 `totalRice` 比上次上报值增长 **> 500 碗**，忽略本次更新（不写入，保留旧值），按拒绝返回。允许余额下降（用户重置）但不得为负。首次上报无此限制。每次上报刷新 `updated_at`。

### 5.2 `GET /api/rank/top?limit=50&deviceId=<uuid>`

- `limit`：1–100，默认 50；
- `deviceId` 可选，用于返回「我的排名」。

成功：

```json
{
  "ok": true,
  "updatedAt": 1762312345678,
  "ranks": [{ "rank": 1, "nickname": "深海大肥鱼", "totalRice": 8888.8, "updatedAt": 1762312345678 }],
  "me": { "rank": 42, "nickname": "匿名肥鱼", "totalRice": 66.6 } 
}
```

`me` 未找到或未传 `deviceId` 时为 `null`。不返回 `deviceId`（隐私）。

错误：`400 INVALID_DEVICE_ID | INVALID_LIMIT`，`405`，`500 CONFIG_MISSING | DB_ERROR`，`504 SUPABASE_TIMEOUT`。

### 5.3 后端实现要求

- CommonJS（`module.exports = async (req,res)=>{}`），Vercel Node 20+。
- `api/_lib/supabase.js`：懒加载单例；缺环境变量时抛错并由 handler 转成 `CONFIG_MISSING`。
- 所有 Supabase 调用加 **8 秒超时**（`Promise.race` + 定时器），超时 `SUPABASE_TIMEOUT`。
- 错误日志用 `console.error`，但响应中**不得泄露** key、SQL、堆栈。
- `api/rank/update.js` 通过 `supabase.rpc('report_rank', { p_device_id, p_nickname, p_total_rice })` 落库；`api/rank/top.js` 直接查表。
- 不记录 IP，不落任何个人隐私。

## 6. Supabase 数据库

见 `supabase/schema.sql`，必须包含：

```sql
create table if not exists public.rankings (
  device_id uuid primary key,
  nickname text not null,
  total_rice numeric(12,1) not null default 0 check (total_rice >= 0),
  last_reported_rice numeric(12,1) not null default 0,
  last_report_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- 索引 `(total_rice desc, updated_at asc)`；
- 开启 RLS，且**不给 anon/authenticated 任何策略/权限**（只有 service_role 能访问）；
- `report_rank(uuid,text,numeric)` 为 `security definer` 函数，内部 `pg_advisory_xact_lock` 串行化同设备请求，返回 jsonb（字段：`ok, rejected, reason, message, retryAfterSeconds, rank, totalRice, nickname`）；
- 函数 `revoke` 掉 `public/anon/authenticated` 的执行权限，只 `grant` 给 `service_role`；
- 附中文注释。

## 7. 扩展前端要求

### 7.1 manifest.json

- `manifest_version: 3`，名称「大肥鱼的白饭日记」，版本 `1.0.0`；
- `permissions: ["storage","alarms"]`；
- `host_permissions`：`https://api.deepseek.com/*`、`https://*.vercel.app/*`、`http://localhost:3000/*`；
- `action.default_popup = "popup.html"`，图标 16/32/48/128 指向 `icons/iconXX.png`；
- `background.service_worker = "background.js"`（非 module，内部 `importScripts('shared.js')`）；
- `minimum_chrome_version: "102"`；
- 不含任何远程代码 / `eval`。

### 7.2 popup.html（内联 CSS，禁止外链字体/框架）

- 固定宽度 **380px**，最小高度 560px，最大高度 600px；
- 主色 `#4D6BFE`，Q 版萌系；浅蓝渐变背景 + 白色圆角卡片 + 轻阴影；深色文字 `#1F2A44`；辅助色 `#FFB84D`（米饭黄）；
- 结构：Header（圆形头像 + 标题 + 设置齿轮）→ Tab 栏（🍚 干饭 / 🏆 成就墙 / 🐟 干饭榜）→ 三个 panel → Toast 容器；
- Header 右上角状态圆点（已配置/未配置/请求中）；
- 动画：鱼上下浮动、按钮按压、Toast 弹入 + emoji 放大、成就卡片解锁高亮；
- 必须包含 `prefers-reduced-motion` 降级。

### 7.3 主界面（干饭 panel）

1. `assets/deepseek-chibi.webp` 立绘（185px 高的半身裁切，object-fit: cover + 底部渐隐），下方气泡文案；Header 使用 `deepseek-chibi-avatar.webp` 圆形头像；
2. 两张大数字卡片：「今日干饭量」`X 碗`、「当前余额」`X.XX 元`；
3. 次级信息：累计干饭 `X 碗`、连续干饭 `X 天`、上次更新 `HH:mm:ss`；
4. 主按钮「🍚 再吃一口（刷新）」；请求中禁用 + 文案「干饭中…」；成功后按钮旁/下方出现本次战果 `本次干了 X 碗`；
5. 未配置 API Key 时：主界面显示引导卡片 +「去填写 Key」按钮；
6. 请求失败时：红色错误条（可关闭），显示中文错误原因；`NO_KEY` 不显示红色错误而是引导。

### 7.4 设置 panel

- API Key 密码输入框 + 显示/隐藏眼睛按钮；placeholder `sk-...`；
- 排行榜昵称（默认「匿名肥鱼」，maxlength 20，含随机昵称按钮「🎲 换一个」）；
- 开关：参与匿名排行榜（`syncEnabled`）；
- 自动刷新间隔下拉：15/30/60/120 分钟；
- 高级：后端 API 地址（默认 `https://bigfatfish-riceeater.vercel.app`，保存时去掉尾部 `/`）；
- 按钮：「保存设置」「测试连接」「清空本地数据（危险）」；
- 保存成功 Toast「设置已保存」；测试连接显示「✅ 连接成功，余额 X 元」或错误；清空需 `confirm`，随后重载 UI。

### 7.5 成就墙 panel

- 顶部统计：`已解锁 3 / 16` + 进度条；
- 分组标题：财富阶级 / 连吃天数 / 特殊事件 / 排行榜互动；
- 卡片网格（2 列）：解锁显示 emoji、名称、文案、解锁日期（`M月D日`）；未解锁整体置灰、emoji 变 `❔`、名称显示 `???`、文案显示 `???`，并显示条件提示 `condition`（灰色小字）；
- 解锁卡片带蓝色描边 + 轻微光晕；hover 上浮。

### 7.6 干饭榜 panel

- 顶部说明「匿名参榜 · 只上传昵称与白饭数」+ 刷新按钮；
- 前三名特殊配色（金/银/铜）；
- 每行：名次、昵称（过长省略号）、`X 碗`；自己高亮并标「我」；
- 「我的排名」卡片显示在榜单上方，未上榜显示「还没上榜，去主界面吃一口」；
- 空榜/失败态、loading 骨架都要有；
- 首次进入该 Tab 自动加载，缓存 60 秒内不重复请求（`BFF.loadRankCache` 可选，直接用 `BFF.refreshRank` 即可）。

### 7.7 popup.js

- 只通过 `BFF.*` 访问存储/网络/成就，不重复实现换算与判定；
- 打开即 `render()`：读 settings/state/achievements 渲染三个面板；若已配置 Key，静默 `BFF.refreshAll({trigger:'popup'})` 并在完成后重新渲染 + 弹 Toast；
- 展示 `BFF.consumePendingToasts()`（包括后台定时刷新攒下的）；
- 统一错误文案映射：`AUTH→'API Key 无效或已过期'`，`TIMEOUT→'请求超时，鱼都饿晕了'`，`NETWORK→'网络不通，检查代理/网络'`，`HTTP→'服务器返回异常'`，`API→'余额接口返回异常'`，`NO_KEY→'还没填 API Key'`；
- 所有用户输入必须转义后再插入 DOM（防 XSS）：昵称、后端错误信息走 `textContent`；
- 事件用 `addEventListener`，不写内联 `onclick`；
- 刷新按钮防连点；保存设置后若 `refreshMinutes` 变化，`chrome.runtime.sendMessage({type:'BFF_ALARM_RESET'})`；
- 监听 `chrome.storage.onChanged`（`bff_state`/`bff_achievements`）自动重渲染（避免与自身写入互相触发死循环：只重渲染，不再次 refresh）。

### 7.8 background.js

- `importScripts('shared.js')`；
- `onInstalled`：创建/重建 alarm（周期取 `settings.refreshMinutes`，限制 15–720 分钟；MV3 最小 0.5 分钟，这里用 15 起步）；
- `onStartup`：确保 alarm 存在；
- `alarms.onAlarm`：命中 `bff-balance-refresh` → `BFF.refreshAll({trigger:'alarm'})`；
- `onMessage`：支持 `{type:'BFF_ALARM_RESET'}`（重建 alarm）、`{type:'BFF_REFRESH_NOW'}`（立即刷新并返回结果）；异步响应 `return true`；
- `storage.onChanged`：设置或 state 变化时更新 action badge（今日白饭碗数，整数，最高显示 `99+`；蓝色 `#4D6BFE` 背景、白字）；
- 所有异常 `console.warn` 中文日志，绝不抛出未捕获异常导致 SW 崩溃。

### 7.9 形象素材（v1.1.0 起）

- 主界面：`extension/assets/deepseek-chibi.webp`（941 × 1672 WebP，社区二创「大肥鱼娘」立绘）；
- Header 头像：`extension/assets/deepseek-chibi-avatar.webp`（640 × 640 WebP，由立绘裁切，裁切区域 x=160, y=40, 640×640）；
- 扩展图标：`scripts/make_icons.py` 用 Pillow 以头像为输入，生成 DeepSeek 蓝圆角底 + 圆形头像的 16/32/48/128 PNG；
- 素材授权：**CC BY-NC-SA 4.0**（署名：原作「溟月」@上善无形 · DeepSeek 形象 @ZipZipPipe · 二创 @这个刀子真甜）；**图片不适用仓库的 MIT 代码许可**，禁止商业使用，改编需同协议共享；完整说明见 `extension/assets/ATTRIBUTION.md`；
- 不再使用任何外部 SVG 吉祥物；页面中不得出现远程图片或 base64 大图。

## 8. README / 开源文件

- README 风格：幽默、带梗、赛博打工人语气，但信息完整；必须包含：
  banner 标题 + 一句话简介 + AI 生成徽章 + 徽章（Chrome MV3 / Vercel / Supabase / MIT / CC BY-NC-SA）、
  目录、功能特性（配 emoji）、成就表（16 个）、截图位（`docs/screenshot-main.png` 等三张真实截图）、
  快速开始（① Supabase 建表 ② Vercel 部署 ③ 加载扩展 ④ 填写 Key）、
  环境变量表、API 文档、项目结构、防作弊说明、隐私说明、常见问题（余额为什么没变 / 401 / 排行榜不动 / 自定义后端域名）、
  免责声明（非 DeepSeek 官方、AI 生成声明、API Key 仅存本地、排行榜公开昵称请勿使用真名、形象素材 CC BY-NC-SA 4.0）、License、贡献指南。
- `.env.example` 仅两项：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`，附中文注释与安全警告。
- `.gitignore`：`node_modules/`、`.env*`（保留 `.env.example`）、`.vercel/`、`*.log`、`.DS_Store`、`Thumbs.db`。
- LICENSE：MIT，版权人 `BigFatFish RiceEater Contributors`，年份 2026。

## 9. 质量门禁

- 所有 `.js` 通过 `node --check`；`manifest.json`/`package.json` 可 `JSON.parse`；
- `node tests/logic.test.js` 全绿；
- 无 TODO / 无 `...` 占位 / 无未使用且报错的引用；
- 扩展目录可直接「加载已解压的扩展程序」；
- 后端两个 handler 在缺少环境变量时返回 500 JSON 而非崩溃；
- 所有文件 UTF-8 无 BOM，换行 LF（Windows 下写入后由 Lead 统一校验）。
