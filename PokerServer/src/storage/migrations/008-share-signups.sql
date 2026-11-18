-- 分享链接带来的新人（2026-11-17）。
-- 没登录的人打开一条牌谱分享链接，之后在同一个浏览器里建了游客号或注册了，就记一行。
-- 用来回答「分享这个功能到底带来了多少人」：运营面板上的 生成 → 打开 → 进来 → 打过牌 → 保存成正式账号。
--
-- 刻意【不挂外键】：
--   · user_id：一手没打的游客 7 天后会被整行删掉（user-repository.purgeStaleGuests），挂了外键就删不掉；
--     删掉之后这行留着，「进来过几个人」才不会自己慢慢变小。
--   · token：分享人注销时他的分享链接会被删掉（account-deletion-repository），挂了外键同样删不掉。
-- 注销的是【进来的这个人】时，user_id 置空、这行留下（见 account-deletion-repository）。
CREATE TABLE IF NOT EXISTS share_signups (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token          TEXT NOT NULL,
    user_id        TEXT,
    kind           TEXT NOT NULL,          -- 'guest' | 'register'
    created_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_signups_user ON share_signups(user_id);
