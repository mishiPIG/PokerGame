// ===== 人头牌画法（2026-11-17，美术第二轮 ⑤）=====
// 玩家在「设置 → 外观 → 人头牌」里选：书法印章（默认）/ 道服武者 / 经典字母。
// 和「扑克风格」（四色 / 标准 / 黑面 / 大字）是两个独立的选项，可以任意组合 ——
// 图案一律用 currentColor 画，牌是什么颜色、图案就是什么颜色，所以四色 / 两色 / 黑面都自动对。
//
// 每张 J/Q/K 里同时放两套画法，按【牌的实际宽度】由 CSS 容器查询挑一套（20-table.css 的 .face-art）：
//   · 宽 ≥ 66px（电脑上的公共牌和自己的牌）：完整牌面 —— 四角角标 + 居中图案
//   · 36–66px（手机）：混合版 —— 上半大字母（和数字牌一样好认），下半换成图案
//   · < 36px（对手摊牌的小牌、牌谱里的小牌）：图案藏起来，回到经典的大字母 + 大花色
// 为什么不在 JS 里按尺寸判断：同一张牌会出现在很多地方、大小随屏幕变，样式自己判最稳。
//
// 素材全部是自己画的几何图形；毛笔字是开源字体「马善政楷书」（SIL OFL）只截了「侠后王」三个字（public/fonts/dojo-brush.woff2）。

const FACE_ARTS = ['brush', 'warrior', 'classic'];
const FA_GOLD = '#b8902a', FA_SEAL = '#c8282e', FA_CREAM = '#fbf6ea', FA_SKIN = '#f1dfc0', FA_HAIR = '#2a2420';
const FA_CHAR = { J: '侠', Q: '后', K: '王' };   // i18n-ok: 牌面上的毛笔字是美术元素，中英文界面一样

function faSuitText(sym, x, y, size, fill = 'currentColor') {
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="middle" font-family="'Segoe UI Symbol','Apple Symbols',sans-serif">${sym}</text>`;
}
function faRankText(r, x, y, size) {
    return `<text x="${x}" y="${y}" font-family="DojoRank, Jost, sans-serif" font-weight="700" font-size="${size}" fill="currentColor" text-anchor="middle">${r}</text>`;
}
// 四角角标：左上点数 + 花色，右下旋转 180°
function faCorners(r, sym) {
    const one = faRankText(r, 13, 30, 26) + faSuitText(sym, 13, 50, 17);
    return one + `<g transform="rotate(180 50 70)">${one}</g>`;
}
// 朱红小印，印里一个白色花色（标准两色下黑桃 / 梅花同色，靠它区分）
function faSeal(sym, x, y, w) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${w}" rx="${(w * 0.12).toFixed(1)}" fill="${FA_SEAL}" transform="rotate(-4 ${x + w / 2} ${y + w / 2})"/>`
        + faSuitText(sym, x + w / 2, y + w * 0.78, w * 0.72, '#fff');
}

// 道服武者的半身像（上半部分；完整牌面再旋转 180° 拼成双头）
function faWarriorHalf(r) {
    const g = [];
    g.push(`<path d="M28 70 Q29 55 42 51 L58 51 Q71 55 72 70 Z" fill="currentColor"/>`);                    // 道服
    g.push(`<path d="M42 51 L54 66 M58 51 L46 66" stroke="${FA_CREAM}" stroke-width="3.2" stroke-linecap="round"/>`);   // 交领
    g.push(`<rect x="29" y="64" width="42" height="5" fill="${FA_GOLD}"/>`);                                      // 腰带
    g.push(`<circle cx="50" cy="40" r="9.5" fill="${FA_SKIN}" stroke="currentColor" stroke-width="1.4"/>`);       // 头
    if (r === 'J') {   // 弟子：头巾 + 结
        g.push(`<path d="M41 34 Q50 26 59 34 Q50 31 41 34 Z" fill="${FA_HAIR}"/>`);
        g.push(`<path d="M40.5 37 Q50 33 59.5 37 L59.5 40.5 Q50 37 40.5 40.5 Z" fill="${FA_CREAM}" stroke="currentColor" stroke-width="1"/>`);
        g.push(`<path d="M59 38.5 L67 35 M59 38.5 L66 43" stroke="${FA_CREAM}" stroke-width="2.6" stroke-linecap="round"/>`);
        g.push(`<path d="M59 38.5 L67 35 M59 38.5 L66 43" stroke="currentColor" stroke-width="0.8" stroke-linecap="round"/>`);
    }
    if (r === 'Q') {   // 女武者：高马尾 + 红发带
        g.push(`<path d="M40.5 38 Q41 29 50 29 Q59 29 59.5 38 Q56 33 50 33 Q44 33 40.5 38 Z" fill="${FA_HAIR}"/>`);
        g.push(`<path d="M55 30 Q66 28 69 38 Q70 46 66 52 Q66 41 58 33 Z" fill="${FA_HAIR}"/>`);
        g.push(`<path d="M54.5 29.5 L58.5 33" stroke="${FA_SEAL}" stroke-width="3" stroke-linecap="round"/>`);
    }
    if (r === 'K') {   // 师范：发髻 + 胡须
        g.push(`<path d="M40.5 38 Q41 30 50 30 Q59 30 59.5 38 Q55 34 50 34 Q45 34 40.5 38 Z" fill="#6b6460"/>`);
        g.push(`<ellipse cx="50" cy="27.5" rx="4.5" ry="3.6" fill="#6b6460"/><rect x="47.5" y="25.5" width="5" height="1.8" fill="${FA_GOLD}"/>`);
        g.push(`<path d="M44 43 Q50 56 56 43 Q50 47 44 43 Z" fill="#e9e4dc" stroke="#9a948c" stroke-width="0.8"/>`);
    }
    return g.join('');
}

// 一张人头牌的图案层。r ∈ J/Q/K，sym 是花色符号。art 不认识 / classic → 返回空串（照旧画字母）。
function faceArtSvg(r, sym, art) {
    if (!FA_CHAR[r] || (art !== 'brush' && art !== 'warrior')) return '';
    let full, mix;
    if (art === 'brush') {
        full = `<text x="50" y="92" font-family="DojoBrush, KaiTi, STKaiti, serif" font-size="66" fill="currentColor" text-anchor="middle">${FA_CHAR[r]}</text>`
            + faSeal(sym, 63, 92, 15) + faCorners(r, sym);
        mix = faRankText(r, 50, 58, 56)
            + `<text x="44" y="124" font-family="DojoBrush, KaiTi, STKaiti, serif" font-size="46" fill="currentColor" text-anchor="middle">${FA_CHAR[r]}</text>`
            + faSeal(sym, 66, 100, 22);
    } else {
        const half = faWarriorHalf(r);
        full = `<rect x="18" y="17" width="64" height="106" rx="6" fill="none" stroke="${FA_GOLD}" stroke-width="1.2"/>`
            + half + `<g transform="rotate(180 50 70)">${half}</g>`
            + `<path d="M22 70 H78" stroke="${FA_GOLD}" stroke-width="1"/>` + faCorners(r, sym);
        mix = faRankText(r, 50, 58, 56) + `<g transform="translate(0 58)">${half}</g>` + faSuitText(sym, 82, 132, 14);
    }
    return `<svg class="fa" viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
        + `<g class="fa-full">${full}</g><g class="fa-mix">${mix}</g></svg>`;
}
