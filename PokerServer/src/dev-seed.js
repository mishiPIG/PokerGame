function seedLocalDevUsers({ enabled, db, bcrypt }) {
    if (!enabled) return;
    for (const [username, password] of [
        ['test', 'test'],
        ['test2', 'test2'],
        ['test3', 'test3'],
        ['test4', 'test4']
    ]) {
        const hash = bcrypt.hashSync(password, 8);
        const existing = db.getUserByUsername(username);
        if (existing) db.setPassword(existing.id, hash);
        else db.createUser(username, hash, false, null);
    }
    console.log('🧪 本地开发账号已就绪：test～test4（密码与账号相同）');
}

module.exports = { seedLocalDevUsers };
