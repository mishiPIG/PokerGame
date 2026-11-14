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

// 先说清楚写的是哪个库。生产的库路径只在 pm2 的环境变量里（POKER_DB_PATH），
// 直接敲 node create-admin.js 时没有它 —— 会落到代码目录下的本地开发库，
// 然后照样打印「✅ 已设为管理员」，而线上什么都没变。
console.log(`数据库：${db.databasePath}`);
if (!process.env.POKER_DB_PATH) {
    console.log('⚠️ 没有设置 POKER_DB_PATH，上面是【本地开发库】。要改线上的库请这样运行：');
    console.log('   POKER_DB_PATH=<生产库路径> node create-admin.js <用户名> <密码>');
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
