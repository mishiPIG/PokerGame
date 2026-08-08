#!/usr/bin/env node
'use strict';
/**
 * 生成头像库（扑克 + 道场主题）。
 * 设计约束：座位上只有 44px，所以一律「单一主体 + 大色块 + 高对比」，不放细节；
 * 深色牌桌背景下要立得住，故每个都有自带底色圆形。
 *
 * 用法：node tools/gen-avatars.js        → 写入 avatars/b1.svg … b16.svg
 * ⚠️ 不删除旧的 a1–a12：已有用户的 avatar 字段存的是 /avatars/aN.svg，删了他们头像会变裂图。
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'avatars');
const S = 120, C = 60;   // viewBox 120，圆心 60

const wrap = (bg, inner, id) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`
    + `<defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient></defs>`
    + `<circle cx="${C}" cy="${C}" r="${C}" fill="url(#g${id})"/>${inner}</svg>`;

// —— 花色路径（居中、粗壮）——
const SPADE = c => `<path fill="${c}" d="M60 26c-12 12-26 22-26 35a15 15 0 0 0 24 12l-5 17h14l-5-17a15 15 0 0 0 24-12c0-13-14-23-26-35z"/>`;
const HEART = c => `<path fill="${c}" d="M60 92S30 72 30 51a16 16 0 0 1 30-8 16 16 0 0 1 30 8c0 21-30 41-30 41z"/>`;
const DIAMOND = c => `<path fill="${c}" d="M60 24 88 60 60 96 32 60z"/>`;
const CLUB = c => `<path fill="${c}" d="M60 24a15 15 0 0 0-11 25 15 15 0 1 0-7 27 15 15 0 0 0 13-8l-5 22h20l-5-22a15 15 0 0 0 13 8 15 15 0 1 0-7-27A15 15 0 0 0 60 24z"/>`;

// —— 主体元件 ——
const chip = (rim, face) => `<circle cx="${C}" cy="${C}" r="38" fill="${rim}"/><circle cx="${C}" cy="${C}" r="27" fill="${face}"/>`
    + [0, 60, 120, 180, 240, 300].map(a => {
        const r = (a * Math.PI) / 180, x = C + 33 * Math.cos(r), y = C + 33 * Math.sin(r);
        return `<rect x="${(x - 5).toFixed(1)}" y="${(y - 8).toFixed(1)}" width="10" height="16" rx="3" fill="${face}" transform="rotate(${a + 90} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
    }).join('');

const torii = c => `<g fill="${c}">`                    // 鸟居（呼应「德扑道场」logo）
    + `<rect x="22" y="36" width="76" height="9" rx="3"/>`
    + `<rect x="29" y="50" width="62" height="7" rx="2.5"/>`
    + `<rect x="36" y="45" width="10" height="45" rx="3"/>`
    + `<rect x="74" y="45" width="10" height="45" rx="3"/></g>`;

const enso = c => `<circle cx="${C}" cy="${C}" r="30" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" stroke-dasharray="160 30" transform="rotate(120 ${C} ${C})"/>`;

const crown = c => `<path fill="${c}" d="M28 78h64l6-38-21 14-17-24-17 24-21-14z"/><rect x="28" y="82" width="64" height="10" rx="4" fill="${c}"/>`;

const bolt = c => `<path fill="${c}" d="M68 22 38 66h18l-8 34 32-48H62z"/>`;

const dice = (c, dot) => `<rect x="28" y="28" width="64" height="64" rx="14" fill="${c}"/>`
    + [[45, 45], [75, 45], [60, 60], [45, 75], [75, 75]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="${dot}"/>`).join('');

const cardBack = (c, line) => `<rect x="33" y="24" width="54" height="72" rx="8" fill="${c}"/>`
    + `<rect x="39" y="30" width="42" height="60" rx="5" fill="none" stroke="${line}" stroke-width="3"/>`
    + `<path d="M60 38 74 60 60 82 46 60z" fill="${line}"/>`;

const aceCard = (c, ink) => `<rect x="33" y="24" width="54" height="72" rx="8" fill="${c}"/>`
    + `<text x="60" y="72" font-family="Georgia,serif" font-size="46" font-weight="bold" fill="${ink}" text-anchor="middle">A</text>`;

const fox = c => `<g fill="${c}"><path d="M60 90 26 62l6-30 20 12h16l20-12 6 30z"/></g>`
    + `<circle cx="49" cy="60" r="5" fill="#1b1b1b"/><circle cx="71" cy="60" r="5" fill="#1b1b1b"/>`
    + `<path d="M55 74h10l-5 6z" fill="#1b1b1b"/>`;

const star = c => `<path fill="${c}" d="M60 24 71 50l28 2-21 18 6 27-24-15-24 15 6-27-21-18 28-2z"/>`;

const cat = c => `<path fill="${c}" d="M32 44 38 22l16 12h12l16-12 6 22v22a28 28 0 0 1-56 0z"/>`
    + `<circle cx="48" cy="62" r="5" fill="#1b1b1b"/><circle cx="72" cy="62" r="5" fill="#1b1b1b"/>`
    + `<path d="M56 76h8l-4 5z" fill="#1b1b1b"/>`;

const AVATARS = [
    { bg: ['#1f6f4a', '#0d3d28'], inner: SPADE('#f2f7f4') },        // b1 黑桃
    { bg: ['#c1352f', '#7a1712'], inner: HEART('#fff1ee') },        // b2 红心
    { bg: ['#2563a8', '#123a68'], inner: DIAMOND('#eaf3ff') },      // b3 方块
    { bg: ['#12876a', '#065141'], inner: CLUB('#eafff8') },         // b4 梅花
    { bg: ['#3a3f5c', '#1b1e2e'], inner: chip('#d94a3d', '#fdf6ea') },  // b5 红筹码
    { bg: ['#2b3350', '#151a2b'], inner: chip('#2f7fd4', '#f2f8ff') },  // b6 蓝筹码
    { bg: ['#4a2b6b', '#241239'], inner: cardBack('#f6efff', '#7a4fb5') }, // b7 牌背
    { bg: ['#8a6a20', '#4a3708'], inner: aceCard('#fffdf5', '#2a2000') },  // b8 A
    { bg: ['#b8862b', '#6b4a10'], inner: crown('#fff6d9') },        // b9 皇冠
    { bg: ['#2f4a3e', '#16261f'], inner: torii('#ff6b57') },        // b10 鸟居（道场）
    { bg: ['#1d2b34', '#0c151b'], inner: enso('#e9d8a6') },         // b11 禅圆（道场）
    { bg: ['#6b2b4a', '#361325'], inner: bolt('#ffd166') },         // b12 闪电
    { bg: ['#2b4a6b', '#122436'], inner: dice('#f7f9fc', '#1b2b3a') },  // b13 骰子
    { bg: ['#a5451f', '#5c2109'], inner: fox('#ffd9a8') },          // b14 狐面
    { bg: ['#20455c', '#0d2130'], inner: star('#ffd166') },         // b15 星
    { bg: ['#4a4a4a', '#222'], inner: cat('#e8e3d8') }              // b16 猫
];

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
AVATARS.forEach((a, i) => {
    const name = `b${i + 1}.svg`;
    fs.writeFileSync(path.join(OUT, name), wrap(a.bg, a.inner, i + 1));
});
console.log(`已生成 ${AVATARS.length} 个新头像 → ${OUT}/b1.svg … b${AVATARS.length}.svg`);
console.log('（旧的 a1–a12 保留：已有用户的 avatar 字段指向它们，删掉会变裂图）');
