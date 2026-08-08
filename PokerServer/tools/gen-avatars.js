#!/usr/bin/env node
'use strict';
/**
 * 生成头像库（扑克 + 道场主题）。
 * 设计约束：座位上只有 44px，所以一律「单一主体 + 大色块 + 高对比」，不放细节；
 * 深色牌桌背景下要立得住，故每个都有自带底色圆形。
 *
 * 用法：node tools/gen-avatars.js        → 写入 avatars/b1.svg … b27.svg
 * 旧的 a1–a12 已于 2026-08-08 移除（玩家反映太丑）；引用它们的用户 avatar 已清空 → 回退显示首字母色块。
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

// —— 第二批（b17–b27）：继续「单一主体 + 大色块」——
const moon = c => `<path fill="${c}" d="M74 26a34 34 0 1 0 0 68 40 40 0 0 1 0-68z"/>`;
const fan = c => `<g fill="${c}"><path d="M60 92 24 52a48 48 0 0 1 72 0z"/></g>`
    + `<path d="M60 92 46 60M60 92l14-32" stroke="#1b1b1b" stroke-width="3" opacity=".35" fill="none"/>`;
const sake = c => `<path fill="${c}" d="M36 40h48l-6 30a18 18 0 0 1-36 0z"/><rect x="32" y="34" width="56" height="8" rx="4" fill="${c}"/>`
    + `<rect x="52" y="88" width="16" height="6" rx="3" fill="${c}"/>`;
const koi = c => `<path fill="${c}" d="M40 60c0-16 14-28 30-28 0 0-8 12-8 28s8 28 8 28c-16 0-30-12-30-28z"/>`
    + `<path fill="${c}" d="M28 46l14 14-14 14z"/><circle cx="62" cy="52" r="4" fill="#1b1b1b"/>`;
const mountain = c => `<path fill="${c}" d="M18 88 46 44l16 22 10-14 30 36z"/>`;
const shuriken = c => `<path fill="${c}" d="M60 20 72 48 100 60 72 72 60 100 48 72 20 60 48 48z"/><circle cx="60" cy="60" r="7" fill="#1b1b1b" opacity=".5"/>`;
const flame = c => `<path fill="${c}" d="M60 22c14 16 22 24 22 38a22 22 0 0 1-44 0c0-8 4-14 10-20 2 6 6 8 8 4 3-6 1-14 4-22z"/>`;
const anchor = c => `<g fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round">`
    + `<path d="M60 40v50"/><path d="M34 68a26 26 0 0 0 52 0"/><path d="M44 44h32"/></g><circle cx="60" cy="30" r="9" fill="${c}"/>`;
const eye = c => `<path fill="${c}" d="M20 60s16-22 40-22 40 22 40 22-16 22-40 22S20 60 20 60z"/><circle cx="60" cy="60" r="12" fill="#1b1b1b"/>`;
const clover = c => `<g fill="${c}"><circle cx="60" cy="40" r="14"/><circle cx="44" cy="58" r="14"/><circle cx="76" cy="58" r="14"/>`
    + `<path d="M57 66h6l4 28h-14z"/></g>`;
const bamboo = c => `<g fill="${c}"><rect x="50" y="20" width="20" height="26" rx="6"/><rect x="50" y="50" width="20" height="26" rx="6"/>`
    + `<rect x="50" y="80" width="20" height="20" rx="6"/><path d="M70 40c14-6 20-2 24 4-10 6-18 4-24-4z"/></g>`;

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
    { bg: ['#4a4a4a', '#222'], inner: cat('#e8e3d8') },             // b16 猫
    { bg: ['#1b2a4a', '#0a1428'], inner: moon('#f2e6c0') },         // b17 月
    { bg: ['#7a2b3a', '#3d1119'], inner: fan('#ffe0d0') },          // b18 扇
    { bg: ['#2d4a2b', '#152616'], inner: sake('#f4e6c8') },         // b19 酒器
    { bg: ['#12556b', '#062b38'], inner: koi('#ff8f5e') },          // b20 锦鲤
    { bg: ['#3a5a7a', '#16293b'], inner: mountain('#e6f0f7') },     // b21 山
    { bg: ['#33384a', '#171a24'], inner: shuriken('#cfd8e3') },     // b22 手里剑
    { bg: ['#7a3410', '#3a1705'], inner: flame('#ffce54') },        // b23 焰
    { bg: ['#1d3b52', '#0a1c29'], inner: anchor('#dbe9f5') },       // b24 锚
    { bg: ['#4a2350', '#200f26'], inner: eye('#f0d9ff') },          // b25 眼
    { bg: ['#1e6b3a', '#0b3319'], inner: clover('#c9f2b0') },       // b26 四叶草
    { bg: ['#26543f', '#0f2a1e'], inner: bamboo('#a8d98b') }        // b27 竹
];

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
AVATARS.forEach((a, i) => {
    const name = `b${i + 1}.svg`;
    fs.writeFileSync(path.join(OUT, name), wrap(a.bg, a.inner, i + 1));
});
console.log(`已生成 ${AVATARS.length} 个新头像 → ${OUT}/b1.svg … b${AVATARS.length}.svg`);

