-- 游客账号（2026-11-17）。
--
-- 为什么要有：第一次点进来的人要 用户名 + 邮箱 + 密码 + 收验证码 才能看到游戏，
-- 100 个账号里 24 个注册完一手没打就走了。游客 = 只填一个昵称就能进来打牌。
--
-- 🔴 设计上最要紧的一条：游客【从第一秒起就是 users 表里的一行正式记录】，只是带着 is_guest=1。
--    「保存账号」只是在同一行上补用户名 / 邮箱 / 密码并把标记去掉 —— id 不变，
--    所以钱包、牌谱、战绩【没有任何东西需要迁移】，也就不存在「搬到一半」的状态。
--    （另开一张 guests 表、升级时再搬数据的做法，出错面正好就在「搬」那一步。）
--
-- upgraded_at_ms：记下「这个号是游客转正的、什么时候转的」。转正后 is_guest 变回 0，
--    不留这一列就再也分不清谁是游客转来的 —— 那「提醒保存账号」到底有没有用就无从知道。
ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0 CHECK (is_guest IN (0, 1));
ALTER TABLE users ADD COLUMN upgraded_at_ms INTEGER;

-- 清理过期游客时要扫「所有游客」，部分索引让这次扫描不碰正式用户
CREATE INDEX IF NOT EXISTS idx_users_guest ON users(created_at_ms) WHERE is_guest = 1;

-- 按天累计的计数器。现在只有一个 key：guest_created（当天建了多少个游客号）。
--
-- 为什么不直接数 users 表：一手没打的游客 7 天后会被【整行删掉】（见 user-repository.purgeStaleGuests），
-- 删完之后「那天来了多少游客」就数不出来了 —— 而它正是「游客 → 打过牌 → 保存账号」这条漏斗的分母。
-- day 按 UTC+8 存，和 metrics-repository.js 的日界线一致。
CREATE TABLE IF NOT EXISTS daily_counters (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    n   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
);
