-- 牌友系统（2026-09-13）。产品名叫「好友开房」，但在此之前全库连 friend 这个词都没有。
--
-- 关系存【两行】（A→B 和 B→A 各一行），不是一行双向：
--   · 查「我的好友」只需 WHERE user_id = ? ，不必写 (a = ? OR b = ?) 那种两头都要看的条件，
--     索引也能用上；
--   · note（备注）天然是【各记各的】—— 我给你的备注不该让你看见，存两行才放得下两份备注。
--   代价是写入要成对维护，由 friend-repository 的事务保证，绝不散落在业务代码里。
--
-- status 的含义（都从「我」这一行的视角看）：
--   pending   我发出了申请，等对方同意（对方那一行是 incoming）
--   incoming  对方向我发了申请，等我处理
--   accepted  双方已是好友
--   blocked   我拉黑了对方（预留，第 1 批不做 UI）
CREATE TABLE IF NOT EXISTS friendships (
    user_id       TEXT NOT NULL REFERENCES users(id),
    friend_id     TEXT NOT NULL REFERENCES users(id),
    status        TEXT NOT NULL CHECK (status IN ('pending', 'incoming', 'accepted', 'blocked')),
    note          TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id),
    CHECK (user_id <> friend_id)          -- 不能加自己为好友
);

-- 「谁向我发了申请」「我的好友有哪些」都是按 (user_id, status) 查
CREATE INDEX IF NOT EXISTS idx_friendships_user_status
ON friendships(user_id, status);
