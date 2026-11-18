function createAuth({ db, jwt, jwtSecret }) {
    // 游客的令牌给一年：正式用户 30 天过期后重新输密码就行，游客【没有密码】——
    // 令牌一过期这个号就再也进不去了，等于丢号。（一手没打的游客 7 天后会被清理，不会因此堆积。）
    const signToken = user => jwt.sign(
        { id: user.id, username: user.username, isAdmin: !!user.isAdmin, isGuest: !!user.isGuest },
        jwtSecret,
        { expiresIn: user.isGuest ? '365d' : '30d' }
    );
    const userPayload = user => ({
        id: user.id, username: user.username, displayName: user.displayName, displayNameChangedAtMs: user.displayNameChangedAtMs, gold: user.gold,
        isAdmin: !!user.isAdmin, email: user.email || null, isGuest: !!user.isGuest
    });

    function requireAdmin(req, res, next) {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录', k: 'notLoggedIn' });
        try {
            const payload = jwt.verify(authorization.slice(7), jwtSecret);
            const user = db.getUserById(payload.id);
            if (!user?.isAdmin) return res.status(403).json({ error: '无管理员权限', k: 'notAdmin' });
            req.adminUser = user;
            next();
        } catch {
            res.status(401).json({ error: '登录已过期', k: 'sessionExpired' });
        }
    }

    // 封禁（2026-11-18）：登录、HTTP、socket 三处闸都查这一个字段。
    // 读取层（getUserById）刻意不按封禁过滤 —— 管理员要看得到、能解封。
    const BANNED = { error: '账号已被封禁', k: 'banned' };

    function requireAuth(req, res, next) {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录', k: 'notLoggedIn' });
        try {
            const payload = jwt.verify(authorization.slice(7), jwtSecret);
            const user = db.getUserById(payload.id);
            if (!user) return res.status(401).json({ error: '用户不存在', k: 'noSuchUser' });
            if (user.bannedAtMs) return res.status(403).json(BANNED);
            req.authUser = user;
            next();
        } catch { res.status(401).json({ error: '登录已过期', k: 'sessionExpired' }); }
    }

    function registerSocketAuth(io) {
        io.use((socket, next) => {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error('未登录'));
            try {
                const payload = jwt.verify(token, jwtSecret);
                const user = db.getUserById(payload.id);
                if (!user) return next(new Error('用户不存在'));
                // 错误信息用固定的英文代号：客户端认出它就显示「账号已被封禁」（按界面语言），而不是一句中文原文
                if (user.bannedAtMs) return next(new Error('banned'));
                socket.user = { ...user };
                next();
            } catch {
                next(new Error('登录已过期，请重新登录'));
            }
        });
    }

    return { signToken, userPayload, requireAdmin, requireAuth, registerSocketAuth };
}

module.exports = { createAuth };
