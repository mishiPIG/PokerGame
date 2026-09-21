-- 登录/注册来源记录（2026-09-21）。
--
-- 为什么要有：产品此前**完全不知道用户从哪来**——注册和登录都没记 IP，
-- Caddy 也没开访问日志，连事后回溯都做不到（已注册那批人的来源已经永久丢失了）。
-- 两个用途：
--   ① 看用户分布在哪些地区（现在是朋友和朋友的朋友，将来要扩量）；
--   ② 🔴 防同一个人开多账号——尤其是将来做「邀请注册送金币」之后。
--
-- 为什么是【独立表】而不是在 users 上加两列：
--   一个人会登录很多次，而「同 IP 多账号」要查的是**历史**，不是最后一次。
--   加列只能存最后一次，那个信号弱得多（换个网络登录一次就把痕迹盖掉了）。
--
-- ⚠️⚠️ 关于「同 IP = 同一个人」这件事，必须写在这里，免得以后有人照它自动封号：
--   **同 IP 完全不等于同一个人，而且在本产品里误报会非常多。**
--   用户是「朋友和朋友的朋友」——同宿舍、同公司、同一个家、同一个咖啡馆都共享出口 IP；
--   更要命的是手机运营商的 CGNAT，**成千上万人共用一个出口 IP**。
--   所以这张表里的同 IP 关系**只能当人工复核的线索，绝不能作为自动封禁的依据**。
--
-- ⚠️ IPv6：地址是按设备分配的、而且会变，有意义的聚合单位是 /64 前缀而不是完整地址。
--   所以除了原始 ip，另存一个 ip_prefix（IPv4 存 /24，IPv6 存 /64）用来做聚合。
--
-- ⚠️ IP 属于个人数据：
--   · 有保留期（见 tools/prune-login-events.js），过期自动清；
--   · **账号注销时必须一并抹掉**（见 account-deletion-repository.js）。
--
-- 地理位置【不在这张表里】：country 走单独的 ip_geo 缓存表，按需解析。
-- 原因是地理库（geoip-lite）一 require 就吃 +108MB 常驻内存，而生产是 1GB 的 t3.micro，
-- 游戏进程绝不能加载它 —— 改成管理员查看时用一次性子进程解析、结果缓存进库。

CREATE TABLE IF NOT EXISTS login_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL REFERENCES users(id),
    kind          TEXT NOT NULL CHECK (kind IN ('signup', 'login')),
    ip            TEXT,                 -- 可能为空：取不到就存 NULL，不要编一个假的
    ip_prefix     TEXT,                 -- IPv4 的 /24 或 IPv6 的 /64，用于聚合
    created_at_ms INTEGER NOT NULL
);

-- 查「这个人从哪些地方登录过」
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at_ms);
-- 查「这个网段下有哪些账号」——防多账号的主查询
CREATE INDEX IF NOT EXISTS idx_login_events_prefix ON login_events(ip_prefix, created_at_ms);
-- 保留期清理按时间扫
CREATE INDEX IF NOT EXISTS idx_login_events_time ON login_events(created_at_ms);

-- IP → 地理位置的缓存。每个 IP 只解析一次，之后永久复用。
CREATE TABLE IF NOT EXISTS ip_geo (
    ip             TEXT PRIMARY KEY,
    country        TEXT,                -- 两位国家码，解析不出来存 NULL
    region         TEXT,
    city           TEXT,
    resolved_at_ms INTEGER NOT NULL
);
