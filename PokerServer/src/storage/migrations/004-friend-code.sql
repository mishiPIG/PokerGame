-- 牌友号（2026-09-13）：加好友的搜索入口需要一个【可以念给朋友听】的标识。
--
-- 为什么不用现成的东西：
--   · 邮箱 —— 能按邮箱搜 = 任何人都能探测「这个邮箱注册过没有」，还会把邮箱暴露给搜的人。
--   · users.id（UUID）—— 不可变是对的，但太长，没人愿意念。
--   · 用户名 / 显示名 —— 显示名可改、会重名，当不了稳定标识。
--
-- 所以另发一个 8 位随机数字，注册时生成、**永不可改**。
-- ⚠️ 随机而不是递增：递增号能被看出「你是第几个注册的」（暴露用户规模），
--    还能顺着号去猜相邻账号。随机没有这两个问题。
--
-- 这里只加列和唯一索引；存量用户的补发在 JS 里做（要处理随机撞号后重试，SQL 不好写）。
ALTER TABLE users ADD COLUMN friend_code TEXT;

-- 部分索引：还没补发的行是 NULL，不参与唯一性约束
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code
ON users(friend_code) WHERE friend_code IS NOT NULL;
