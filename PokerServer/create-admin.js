// 用法：node create-admin.js <用户名> <密码>
// 若用户已存在则直接升级为管理员；若不存在则新建管理员账号
const bcrypt = require('bcryptjs');
const db     = require('./database');

const [,, username, password] = process.argv;

if (!username || !password) {
    console.log('用法: node create-admin.js <用户名> <密码>');
    console.log('示例: node create-admin.js admin MyPass123');
    process.exit(1);
}

let user = db.getUserByUsername(username);

if (user) {
    db.setAdmin(user.id, true);
    console.log(`✅ 已将 "${user.username}" 设为管理员（金币: ${user.gold}）`);
} else {
    const hash = bcrypt.hashSync(password, 10);
    user = db.createUser(username, hash, true);
    console.log(`✅ 创建管理员账号 "${user.username}"，初始金币: ${user.gold}`);
}
