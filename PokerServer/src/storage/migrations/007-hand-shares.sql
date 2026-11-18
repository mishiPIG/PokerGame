-- 牌谱分享链接（2026-11-17）。
-- 一手牌的玩家可以生成一个公开回放链接（不用登录就能看），发到群里。
-- token 是随机的：不能按顺序猜出别的牌局。同一个人分享同一手牌永远拿同一个链接。
-- 看到什么由 src/games/poker/public-hand.js 决定（只看得见分享人当时看得见的牌），不在这里存副本 ——
-- 牌谱本身会因为账号注销被擦名字，读的时候现取才能跟着擦掉。
CREATE TABLE IF NOT EXISTS hand_shares (
    token          TEXT PRIMARY KEY,
    hand_id        TEXT NOT NULL REFERENCES hands(id),
    user_id        TEXT NOT NULL REFERENCES users(id),
    created_at_ms  INTEGER NOT NULL,
    views          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (hand_id, user_id)
);
