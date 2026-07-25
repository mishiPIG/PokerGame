function createAuth({ db, jwt, jwtSecret }) {
    const signToken = user => jwt.sign(
        { id: user.id, username: user.username, isAdmin: !!user.isAdmin },
        jwtSecret,
        { expiresIn: '30d' }
    );
    const userPayload = user => ({
        id: user.id, username: user.username, gold: user.gold,
        isAdmin: !!user.isAdmin, email: user.email || null
    });

    function requireAdmin(req, res, next) {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
        try {
            const payload = jwt.verify(authorization.slice(7), jwtSecret);
            const user = db.getUserById(payload.id);
            if (!user?.isAdmin) return res.status(403).json({ error: '无管理员权限' });
            req.adminUser = user;
            next();
        } catch {
            res.status(401).json({ error: '登录已过期' });
        }
    }

    function requireAuth(req, res, next) {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
        try {
            const payload = jwt.verify(authorization.slice(7), jwtSecret);
            const user = db.getUserById(payload.id);
            if (!user) return res.status(401).json({ error: '用户不存在' });
            req.authUser = user;
            next();
        } catch { res.status(401).json({ error: '登录已过期' }); }
    }

    function registerSocketAuth(io) {
        io.use((socket, next) => {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error('未登录'));
            try {
                const payload = jwt.verify(token, jwtSecret);
                const user = db.getUserById(payload.id);
                if (!user) return next(new Error('用户不存在'));
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
