-- 封禁账号（2026-11-18，管理员功能扩充）。
--
-- 只加两列、不删任何东西：封禁是可撤销的，解封后账号、金币、牌谱、牌友全都原样回来。
-- 和注销（deleted_at_ms）是两回事 —— 注销会抹掉身份，封禁只是「暂时不让进」。
--
-- banned_at_ms 非空 = 封禁中。ban_reason 给管理员自己看（为什么封），不发给被封的人。
-- 读取层不按封禁过滤（getUserById 照常查得到）：管理员要能看到、能解封；
-- 「不让进」由鉴权的三处闸负责（登录、HTTP requireAuth、socket 鉴权），见 src/auth.js。
ALTER TABLE users ADD COLUMN banned_at_ms INTEGER;
ALTER TABLE users ADD COLUMN ban_reason TEXT;
