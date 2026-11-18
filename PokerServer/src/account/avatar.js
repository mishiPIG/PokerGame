'use strict';

// 头像只能是内置那批文件的路径，别的一律当成「没有头像」。
//
// 🔴 2026-11-14：set_avatar 原来只校验「是个字符串」，而客户端把它原样拼进
//    <img src="…">。把头像设成 `x" onerror="…`，同桌每个人的浏览器都会执行那段脚本。
//    所以这里两头都拦：写入时只收白名单；读出时再过一遍（库里已有的脏数据不必改库就失效）。
const AVATAR_RE = /^\/avatars\/b([1-9]|1\d|2[0-7])\.svg$/;

function safeAvatar(value) {
    return (typeof value === 'string' && AVATAR_RE.test(value)) ? value : null;
}

// 新号默认头像（2026-11-17，美术第二轮 ①）：从内置那 27 个里随机给一个。
// 原来新号一律没有头像 → 牌桌上一圈全是首字母色块，像占位符；用户可以随时在「资料与头像」里换掉或选「无」。
const AVATAR_COUNT = 27;
function randomAvatar(rand = Math.random) {
    return `/avatars/b${1 + Math.floor(rand() * AVATAR_COUNT)}.svg`;
}

module.exports = { safeAvatar, randomAvatar, AVATAR_RE, AVATAR_COUNT };
