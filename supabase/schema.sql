-- ============================================================================
-- 大肥鱼的白饭日记 · Supabase 数据库初始化脚本
-- ============================================================================
-- 用途：
--   1. 创建匿名排行榜表 public.rankings；
--   2. 创建复合索引，支撑「按白饭数倒序 + 更新时间正序」的榜单查询；
--   3. 开启 RLS 并收紧权限：只有 service_role（Vercel 后端）能读写；
--   4. 创建防作弊 RPC public.report_rank()，在同一事务内完成：
--        同设备串行锁 -> 5 分钟 / 500 碗增长校验 -> 首次插入或更新 -> 计算名次。
--
-- 使用方式：
--   打开 Supabase 控制台 → SQL Editor → 粘贴本文件全部内容 → Run。
--   本脚本可重复执行（create table/index/function 均为 if not exists / or replace，
--   约束与授权也做了幂等处理），不会因为「已存在」而报错。
--
-- 安全提示：
--   service_role key 拥有绕过 RLS 的最高权限，只能放在 Vercel 环境变量里，
--   绝不能写进 Chrome 扩展或提交到 Git。
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. 排行榜主表
-- ----------------------------------------------------------------------------
-- 字段说明：
--   device_id          ：设备匿名 UUID，主键，同一个设备只保留一行；
--   nickname           ：公开昵称（1-20 字符，由 API 与约束双重保证）；
--   total_rice         ：累计白饭碗数（0.1 元 = 1 碗，保留 1 位小数）；
--   last_reported_rice ：上一次被接受的上报值，用于计算 5 分钟内的增长量；
--   last_report_at     ：上一次被接受上报的时间，用于 5 分钟窗口判断；
--   created_at         ：首次上榜时间；
--   updated_at         ：最近一次被接受上报的时间（榜单排序与前端缓存用）。
create table if not exists public.rankings (
  device_id uuid primary key,
  nickname text not null,
  total_rice numeric(12, 1) not null default 0 check (total_rice >= 0),
  last_reported_rice numeric(12, 1) not null default 0,
  last_report_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 兼容「表已存在但缺少约束」的重复执行场景：按约束名判断后再补。
do $$
begin
  -- 昵称长度：1-20 个字符（与 API 归一化规则一致）。
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.rankings'::regclass
      and conname = 'rankings_nickname_length_chk'
  ) then
    alter table public.rankings
      add constraint rankings_nickname_length_chk
      check (char_length(nickname) between 1 and 20);
  end if;

  -- 白饭上限：防止有人绕过 API 直接写库塞进离谱数值。
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.rankings'::regclass
      and conname = 'rankings_total_rice_range_chk'
  ) then
    alter table public.rankings
      add constraint rankings_total_rice_range_chk
      check (total_rice >= 0 and total_rice <= 10000000);
  end if;

  -- 上次上报值同样不允许为负。
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.rankings'::regclass
      and conname = 'rankings_last_reported_rice_chk'
  ) then
    alter table public.rankings
      add constraint rankings_last_reported_rice_chk
      check (last_reported_rice >= 0);
  end if;
end
$$;

comment on table public.rankings is '大肥鱼的白饭日记：匿名排行榜（只存昵称与白饭数，不存 IP、不存 API Key）';
comment on column public.rankings.device_id is '设备匿名 UUID，主键；仅服务端可见，任何接口都不会返回给客户端';
comment on column public.rankings.nickname is '公开昵称，1-20 个字符，默认「匿名肥鱼」';
comment on column public.rankings.total_rice is '累计白饭碗数（1 碗 = 0.1 元），保留 1 位小数';
comment on column public.rankings.last_reported_rice is '上一次被接受的上报值，用于防作弊增长判断';
comment on column public.rankings.last_report_at is '上一次被接受上报的时间，用于 5 分钟窗口判断';
comment on column public.rankings.created_at is '首次上榜时间';
comment on column public.rankings.updated_at is '最近一次被接受上报的时间';

-- ----------------------------------------------------------------------------
-- 2. 复合索引
-- ----------------------------------------------------------------------------
-- 排行榜固定按「白饭数从高到低」展示；同分时先上榜（updated_at 更早）的排前面。
create index if not exists rankings_total_rice_idx
  on public.rankings (total_rice desc, updated_at asc);

-- ----------------------------------------------------------------------------
-- 3. RLS 与权限
-- ----------------------------------------------------------------------------
-- 开启 RLS 且不创建任何策略：anon / authenticated 即使拿到 publishable key 也读不到数据。
-- 只有 service_role（带 BYPASSRLS）能通过 Vercel 后端访问。
alter table public.rankings enable row level security;

-- 撤销默认权限：PUBLIC 以及 Supabase 的匿名 / 登录角色都不允许直接碰表。
revoke all on table public.rankings from public;
revoke all on table public.rankings from anon;
revoke all on table public.rankings from authenticated;

-- 只授权给服务端角色。
grant select, insert, update, delete on table public.rankings to service_role;

-- ----------------------------------------------------------------------------
-- 4. 防作弊 RPC：report_rank(uuid, text, numeric)
-- ----------------------------------------------------------------------------
-- 规则（原子完成，避免并发绕过）：
--   1. 用 hashtextextended(device_id) 加事务级 advisory lock，同一设备的请求串行执行；
--   2. 若该设备 5 分钟内已有上报，且本次 totalRice 增长 > 500 碗 → 拒绝本次写入；
--   3. 允许 totalRice 下降（用户重置）但不允许为负；
--   4. 首次上报没有增长限制；
--   5. 名次 = 严格比当前 totalRice 大的人数 + 1（并列同名次）。
--
-- 返回 jsonb 字段：ok, rejected, reason, message, retryAfterSeconds, rank, totalRice, nickname。
-- SECURITY DEFINER + 固定 search_path：函数以定义者权限执行，防止被搜索路径劫持。
create or replace function public.report_rank(
  p_device_id uuid,
  p_nickname text,
  p_total_rice numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nickname text;
  v_total numeric;
  v_now timestamptz := now();
  v_last_rice numeric(12, 1);
  v_last_at timestamptz;
  v_growth numeric;
  v_retry_seconds integer;
  v_rank bigint;
begin
  -- 4.1 基础校验：优先在数据库侧再兜一层，避免绕过 API 直接调用 RPC。
  if p_device_id is null then
    return jsonb_build_object(
      'ok', false,
      'rejected', true,
      'reason', 'INVALID_DEVICE_ID',
      'message', '设备标识缺失。',
      'retryAfterSeconds', 0,
      'rank', null,
      'totalRice', null,
      'nickname', null
    );
  end if;

  -- 4.2 昵称归一化：去控制字符 -> trim -> 默认匿名肥鱼 -> 截断到 20 个字符。
  v_nickname := regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', '', 'g');
  v_nickname := btrim(v_nickname);
  if v_nickname = '' then
    v_nickname := '匿名肥鱼';
  end if;
  if char_length(v_nickname) > 20 then
    v_nickname := left(v_nickname, 20);
  end if;

  -- 4.3 白饭数归一化与范围校验。
  -- 先用无精度的 numeric 计算，避免超大输入在类型转换阶段直接抛错。
  v_total := round(coalesce(p_total_rice, 0), 1);
  if v_total is null or v_total < 0 or v_total > 10000000 then
    return jsonb_build_object(
      'ok', false,
      'rejected', true,
      'reason', 'INVALID_TOTAL_RICE',
      'message', '白饭总量必须在 0 到 10000000 之间。',
      'retryAfterSeconds', 0,
      'rank', null,
      'totalRice', null,
      'nickname', v_nickname
    );
  end if;

  -- 4.4 同一设备的请求串行化。
  -- advisory lock 随事务结束自动释放；第二个并发请求会在这里等待，从而看到最新数据。
  perform pg_advisory_xact_lock(hashtextextended(p_device_id::text, 0));

  -- 4.5 读取该设备的当前记录（加行锁，双保险）。
  select total_rice, last_report_at
    into v_last_rice, v_last_at
    from public.rankings
    where device_id = p_device_id
    for update;

  if found then
    -- 4.6 防作弊：5 分钟内增长超过 500 碗则没收本次成绩。
    if v_last_at is not null
       and (v_now - v_last_at) < interval '5 minutes'
       and (v_total - v_last_rice) > 500 then
      -- 距离可以再次上报还需要多少秒（向上取整，至少 0）。
      v_retry_seconds := greatest(
        ceil(extract(epoch from (v_last_at + interval '5 minutes' - v_now)))::integer,
        0
      );

      return jsonb_build_object(
        'ok', false,
        'rejected', true,
        'reason', 'RATE_LIMIT',
        'message', '5 分钟内白饭暴增超过 500 碗，本次成绩已被没收。',
        'retryAfterSeconds', v_retry_seconds,
        'rank', null,
        'totalRice', v_last_rice,
        'nickname', v_nickname
      );
    end if;

    -- 4.7 通过校验：更新昵称与白饭数（允许下降表示用户重置）。
    update public.rankings
       set nickname = v_nickname,
           total_rice = v_total,
           last_reported_rice = v_total,
           last_report_at = v_now,
           updated_at = v_now
     where device_id = p_device_id;
  else
    -- 4.8 首次上榜：没有任何增长限制。
    insert into public.rankings (
      device_id,
      nickname,
      total_rice,
      last_reported_rice,
      last_report_at,
      created_at,
      updated_at
    ) values (
      p_device_id,
      v_nickname,
      v_total,
      v_total,
      v_now,
      v_now,
      v_now
    );
  end if;

  -- 4.9 计算名次：严格比我碗数多的人数 + 1。
  select count(*) + 1
    into v_rank
    from public.rankings
    where total_rice > v_total;

  -- 4.10 成功返回（字段集合与拒绝分支保持一致，方便客户端统一解析）。
  return jsonb_build_object(
    'ok', true,
    'rejected', false,
    'reason', null,
    'message', null,
    'retryAfterSeconds', null,
    'rank', v_rank,
    'totalRice', v_total,
    'nickname', v_nickname
  );
end;
$$;

comment on function public.report_rank(uuid, text, numeric) is
  '匿名上报白饭数：advisory lock 串行化同设备请求，5 分钟内增长 >500 碗则拒绝，返回 jsonb';

-- ----------------------------------------------------------------------------
-- 5. 函数权限
-- ----------------------------------------------------------------------------
-- 默认情况下新函数会授予 PUBLIC 执行权限，这里全部收回，只允许 service_role 调用。
revoke all on function public.report_rank(uuid, text, numeric) from public;
revoke all on function public.report_rank(uuid, text, numeric) from anon;
revoke all on function public.report_rank(uuid, text, numeric) from authenticated;
grant execute on function public.report_rank(uuid, text, numeric) to service_role;

commit;
