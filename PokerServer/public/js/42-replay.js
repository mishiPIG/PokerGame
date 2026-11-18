// ===== 牌谱回放引擎（把一手记录还原成桌面场景，逐步/播放）=====
let rpFrames = [], rpIdx = 0, rpTimer = null, rpPlaying = false, rpSpeedIdx = 0, rpCommunity = [];
const RP_SPEEDS = [1, 1.5, 2, 0.5];
function rpParseCard(str) {
    const suit = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[str.slice(-1)] || 'Spades';
    return { suit, rank: str.slice(0, -1) };
}
function rpRingPos(i, n) {
    const cx = 50, cy = 44, rx = 40, ry = 37;
    const ang = Math.PI / 2 + (2 * Math.PI * i / n);
    return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) };
}
function buildReplayFrames(h) {
    const players = (h.seats || []).slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)).map(s => ({
        userId: s.userId, name: s.username, avatar: s.avatar, seat: s.seat ?? 0,
        stack: s.startChips || 0, bet: 0, folded: false, showCards: false,
        // heroId：示例牌局没有「我」，由牌谱自己指定从谁的视角看（那一家的牌亮着、坐在屏幕下方）
        // 底牌被过滤掉的人（桌子还没散时别人弃掉的牌 / 分享链接里看不见的牌）：画两张牌背，别让他看起来像没拿牌
        hole: s.hole && s.hole.length ? s.hole.map(rpParseCard) : [null, null], isMe: s.userId === (h.heroId || myUserId), pos: ''
    }));
    const byId = {}; players.forEach(p => byId[p.userId] = p);
    const n = players.length;
    const btnI = players.findIndex(p => p.userId === h.buttonUserId);
    if (btnI >= 0 && n >= 2) {
        const sbI = n === 2 ? btnI : (btnI + 1) % n;
        const bbI = n === 2 ? (btnI + 1) % n : (btnI + 2) % n;
        players[btnI].pos = 'BTN';
        players[sbI].pos = (players[sbI].pos ? players[sbI].pos + '/' : '') + 'SB';
        players[bbI].pos = players[bbI].pos ? players[bbI].pos + '/BB' : 'BB';
        if (n >= 4) players[(bbI + 1) % n].pos = 'UTG';   // 三人局里大盲下一位就是按钮，别把 BTN 盖掉
    }
    let pot = 0, community = 0, street = 'preflop';
    const frames = [];
    const snap = (caption, actingId, extra = {}) => frames.push({ players: players.map(p => ({ ...p })), pot, community, caption, actingId, ...extra });
    if (h.ante > 0) players.forEach(p => { const a = Math.min(h.ante, p.stack); p.stack -= a; pot += a; });
    const sbP = players.find(p => (p.pos || '').includes('SB'));
    const bbP = players.find(p => (p.pos || '').includes('BB'));
    if (sbP) { const v = Math.min(h.sb, sbP.stack); sbP.stack -= v; sbP.bet = v; }
    if (bbP) { const v = Math.min(h.bb, bbP.stack); bbP.stack -= v; bbP.bet = v; }
    // 链式 straddle 每一档都记成了一条 'straddle' 行动（UTG 2BB → 下一位 4BB → …）。
    // 原来只扣了 h.straddle（最后一档），前面几档的人筹码没少、桌上也没注，
    // 他们之后一弃牌，回放里的底池就一直少一截。老牌谱没有逐档记录时退回只用最后一档。
    const straddleActs = (h.actions || []).filter(a => a.action === 'straddle');
    const tiers = straddleActs.length ? straddleActs : (h.straddle ? [h.straddle] : []);
    for (const st of tiers) {
        const sp = byId[st.userId]; if (!sp) continue;
        sp.stack -= (st.amount - sp.bet); sp.bet = st.amount;
    }
    snap(`${L('发牌 · 盲注', 'Deal · blinds')} ${h.sb}/${h.bb}${h.ante ? ' ante ' + h.ante : ''}`
        + (tiers.length ? ` · Straddle ${tiers.map(st => st.amount).join(' → ')}` : ''), null);
    const stName = { preflop: L('翻前', 'Preflop'), flop: L('翻牌', 'Flop'), turn: L('转牌', 'Turn'), river: L('河牌', 'River') };
    for (const a of (h.actions || [])) {
        if (a.action === 'straddle') continue;
        if (a.street !== street) {
            players.forEach(p => { pot += p.bet; p.bet = 0; });
            street = a.street;
            community = street === 'flop' ? 3 : street === 'turn' ? 4 : street === 'river' ? 5 : community;
            snap(`${stName[street] || street}`, null);
        }
        const p = byId[a.userId]; if (!p) continue;
        const think = a.thinkMs ? L(` · 思考 ${(a.thinkMs / 1000).toFixed(1)}s`, ` · thought ${(a.thinkMs / 1000).toFixed(1)}s`) : '';
        let cap;
        if (a.action === 'fold') { p.folded = true; cap = `${p.name} ${L('弃牌', 'folds')}`; }
        else if (a.action === 'check') cap = `${p.name} ${L('过牌', 'checks')}`;
        else if (a.action === 'call') { p.stack -= (a.amount - p.bet); p.bet = a.amount; cap = `${p.name} ${L('跟注', 'calls')} ${fmtChips(a.amount)}`; }
        else if (a.action === 'bet') { p.stack -= (a.amount - p.bet); p.bet = a.amount; cap = `${p.name} ${L('下注', 'bets')} ${fmtChips(a.amount)}`; }
        else if (a.action === 'raise') { p.stack -= (a.amount - p.bet); p.bet = a.amount; cap = `${p.name} ${L('加注到', 'raises to')} ${fmtChips(a.amount)}`; }
        else cap = `${p.name} ${a.action}`;
        snap(`${stName[street] || street} · ${cap}${think}`, a.userId);
    }
    players.forEach(p => { pot += p.bet; p.bet = 0; });
    // 多次发牌（run it N times）：原来回放只用 h.community（第 1 次那一组），后面几次根本看不到（2026-11-18 玩家反馈）。
    // 牌谱里每一次的完整公共牌 / 赢家 / 金额都存着（h.runIt.boards / winners / amounts）：每一次单独一帧，最后一帧把 N 组叠在一起总览。
    const rr = h.runIt;
    if (rr && rr.n > 1 && Array.isArray(rr.boards) && rr.boards.length) {
        players.forEach(p => { if (!p.folded) p.showCards = true; });
        snap(L(`全押 · 发 ${rr.n} 次（底池均分）`, `All-in · run it ${rr.n} times (pot split)`), null);
        rr.boards.forEach((bd, i) => {
            const ws = (rr.winners || [])[i] || [];
            const amt = (rr.amounts || [])[i] || 0;
            ws.forEach(id => { const p = byId[id]; if (p) p.stack += Math.floor(amt / ws.length); });
            pot = Math.max(0, pot - amt);
            const names = ws.map(id => byId[id] && byId[id].name).filter(Boolean).join('、');
            snap(`${L(`第 ${i + 1} 次`, `Run ${i + 1}`)} · ${names || L('平分', 'split')} +${fmtChips(amt)}`, null,
                { community: 5, board: (bd || []).map(rpParseCard) });
        });
        // 最终筹码以牌谱记录的结果为准（均分时的零头、边池都已算在里面）
        (h.results || []).forEach(r => { const p = byId[r.userId]; if (p && typeof r.endChips === 'number') p.stack = r.endChips; });
        pot = 0;
        snap(L(`共发 ${rr.n} 次`, `Ran it ${rr.n} times`), null, { community: 5, boards: rr.boards.map(bd => (bd || []).map(rpParseCard)) });
        return frames;
    }
    community = (h.community || []).length;
    players.forEach(p => { if (!p.folded) p.showCards = true; });
    const winners = (h.results || []).filter(r => r.won > 0);
    winners.forEach(r => { const p = byId[r.userId]; if (p) p.stack += r.won; });
    const wn = winners.map(r => byId[r.userId] && byId[r.userId].name).filter(Boolean);
    snap(`${L('摊牌', 'Showdown')} · ${wn.length ? wn.join('、') + L(' 赢得 ', ' won ') + fmtChips(winners.reduce((s, r) => s + r.won, 0)) : L('结束', 'End')}`, null);
    return frames;
}
// ===== 牌谱详情（清爽 breakdown，参考商业软件截图3）=====
let curDetailHand = null;
const HD_ACT = { fold: { t: L('弃', 'F'), c: 'f' }, check: { t: L('过', 'X'), c: 'ck' }, call: { t: L('跟', 'C'), c: 'c' }, bet: { t: L('下', 'B'), c: 'b' }, raise: { t: L('加', 'R'), c: 'r' }, straddle: { t: 'STR', c: 'r' } };
const HD_STREET = { preflop: L('翻前', 'Preflop'), flop: L('翻牌', 'Flop'), turn: L('转牌', 'Turn'), river: L('河牌', 'River') };
function handPositions(seats, buttonUserId) {
    const order = seats.slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    const n = order.length, bi = order.findIndex(s => s.userId === buttonUserId), pos = {};
    if (bi < 0) return pos;
    if (n === 2) { pos[order[bi].userId] = 'D/SB'; pos[order[(bi + 1) % n].userId] = 'BB'; }
    else { pos[order[bi].userId] = 'BTN'; pos[order[(bi + 1) % n].userId] = 'SB'; pos[order[(bi + 2) % n].userId] = 'BB'; }
    return pos;
}
function openHandDetail(h) {
    curDetailHand = h;
    document.getElementById('hd-share-row').style.display = 'none';   // 换了一手，上一手的分享链接收起来
    // 示例牌局 / 别人分享给我的那一手：不是我打的，不能再分享
    document.getElementById('hd-share-btn').style.display = h.handId ? '' : 'none';
    const seats = (h.seats || []).slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    const foldedSet = new Set((h.actions || []).filter(a => a.action === 'fold').map(a => a.userId));
    const showdown = seats.filter(s => !foldedSet.has(s.userId)).length >= 2;
    const pos = handPositions(seats, h.buttonUserId);
    const resById = {}; (h.results || []).forEach(r => resById[r.userId] = r);
    const pot = (h.results || []).reduce((s, r) => s + (r.won || 0), 0);
    const community = (h.community || []).map(rpParseCard);
    const time = fmtDateTime(h.ts);
    document.getElementById('hd-title').textContent = `${L('牌谱详情', 'Hand detail')} · ${h.mode === 'cash' ? L('现金桌', 'Cash') : 'SNG'} ${h.sb}/${h.bb}`;
    const commHtml = [0, 1, 2, 3, 4].map(i => community[i] ? formatCard(community[i]) : emptySlot()).join('');
    // 多次发牌（run it N times）：完整展示每组公共牌 + 该组赢家 + 该份金额
    let runitHtml = '';
    if (h.runIt && h.runIt.n > 1) {
        const rr = h.runIt;
        runitHtml = `<div class="hd-runit"><div class="hd-runit-t">${L(`🎲 本手发了 ${rr.n} 次（底池均分）`, `🎲 Ran it ${rr.n} times (pot split)`)}</div>`
            + (rr.boards || []).map((bd, i) => {
                const cards = (bd || []).map(cs => formatCard(rpParseCard(cs))).join('');
                const wn = ((rr.winners || [])[i] || []).map(id => { const s = seats.find(x => x.userId === id); return s ? s.username : id; }).join(' / ');
                return `<div class="hd-runit-row"><span class="hd-runit-no">${L(`第${i + 1}次`, `#${i + 1}`)}</span><div class="hd-runit-bd">${cards}</div>`
                    + `<span class="hd-runit-w">${ic('trophy', 'c-gold')} ${escapeHtml(wn)} +${fmtChips((rr.amounts || [])[i] || 0)}</span></div>`;
            }).join('') + `</div>`;
    }
    document.getElementById('hd-board').innerHTML =
        `<div class="hd-pot">${time} · ${L('底池', 'Pot')} <b>${fmtChips(pot)}</b></div>`
        + (runitHtml ? runitHtml : `<div class="hd-comm">${commHtml}</div>`);
    document.getElementById('hd-rows').innerHTML = seats.map(s => {
        const isMe = s.userId === myUserId;
        const folded = foldedSet.has(s.userId);
        const showFace = isMe || (!folded && showdown);
        const holeHtml = (s.hole && s.hole.length ? s.hole : [null, null]).map(cs => (showFace && cs) ? formatCard(rpParseCard(cs)) : cardBack()).join('');
        const acts = (h.actions || []).filter(a => a.userId === s.userId);
        let actHtml = '', lastStreet = null;
        acts.forEach(a => {
            if (a.street !== lastStreet) { actHtml += `<span class="hd-st">${HD_STREET[a.street] || a.street}</span>`; lastStreet = a.street; }
            const m = HD_ACT[a.action] || { t: a.action, c: '' };
            const amt = (a.action === 'call' || a.action === 'bet' || a.action === 'raise') && a.amount ? ' ' + fmtChips(a.amount) : '';
            actHtml += `<span class="hd-act ${m.c}">${m.t}${amt}</span>`;
        });
        if (!actHtml) actHtml = '<span class="hd-act">—</span>';
        const res = resById[s.userId] || {};
        const net = (res.endChips ?? s.startChips ?? 0) - (s.startChips || 0);
        const netCls = net > 0 ? 'win' : (net < 0 ? 'lose' : '');
        const av = s.avatar ? `<img src="${escapeHtml(s.avatar)}" onerror="this.style.display='none'">` : escapeHtml((s.username || '?')[0].toUpperCase());
        // 牌型名（服务端已随牌谱存下）。⚠️ 只在牌面本来就可见时才显示：
        // 否则会泄露「弃牌者从未亮过的底牌是什么牌型」——那是本手中谁都不该知道的信息。
        // 自己弃牌的那手可以看（是自己的牌），标注「弃」表示只是假设。
        const catHtml = (showFace && res.category)
            ? `<span class="hd-cat${folded ? ' dim' : ''}">${folded ? L('弃 · ', 'Fold · ') : ''}${escapeHtml(handCat(res.category))}</span>` : '';
        return `<div class="hd-row${folded ? ' folded' : ''}">
            <div class="hd-who"><div class="hd-av" style="background:hsl(${hashHue(s.userId)},45%,42%)">${av}</div>
              <div class="hd-nm">${escapeHtml(s.username)}${isMe ? `<span class="hd-me">${L('你', 'You')}</span>` : ''}${pos[s.userId] ? `<span class="hd-pos">${pos[s.userId]}</span>` : ''}${folded ? `<span class="hd-fold">${L('弃牌', 'Fold')}</span>` : ''}</div></div>
            <div class="hd-hole">${holeHtml}${catHtml}</div>
            <div class="hd-acts">${actHtml}</div>
            <div class="hd-net ${netCls}">${net > 0 ? '+' : ''}${fmtChips(net)}</div>
        </div>`;
    }).join('');
    document.getElementById('hand-detail').style.display = 'flex';
}
function closeHandDetail() { document.getElementById('hand-detail').style.display = 'none'; }
function replayCurrentDetail() { closeHandDetail(); if (curDetailHand) openReplay(curDetailHand); }

function openReplay(h) {
    rpFrames = buildReplayFrames(h);
    // 别人分享来的那一手：没登录的人看完给一个「自己也来玩」（接到游客模式上）
    let loggedIn = false; try { loggedIn = !!localStorage.getItem('token'); } catch {}
    document.getElementById('rp-cta').style.display = (h.shared && !loggedIn) ? '' : 'none';
    rpCommunity = (h.community || []).map(rpParseCard);
    rpIdx = 0; rpPlaying = false;
    const time = fmtDateTime(h.ts);
    const me = (h.seats || []).find(s => s.userId === (h.heroId || myUserId));
    const sharer = h.shared && me ? L(`${me.username} 分享的一手 · `, `Shared by ${me.username} · `) : '';
    document.getElementById('rp-info').textContent = sharer +
        `${time} · ${h.mode === 'cash' ? L('现金桌', 'Cash') : 'SNG'} · ${L('盲注', 'Blinds')} ${h.sb}/${h.bb}${h.ante ? ' ante ' + h.ante : ''} · ${L(`${(h.seats || []).length} 人`, `${(h.seats || []).length} players`)}`
        // 分享来的那一手：「我」是分享人，不是正在看的人
        + (me ? (h.shared
            ? L(` · TA 的后手 ${Math.round((me.startChips || 0) / h.bb)}BB`, ` · their stack ${Math.round((me.startChips || 0) / h.bb)}BB`)
            : L(` · 你的后手 ${Math.round((me.startChips || 0) / h.bb)}BB`, ` · your stack ${Math.round((me.startChips || 0) / h.bb)}BB`)) : '');
    document.getElementById('replay-overlay').style.display = 'flex';
    renderReplayFrame();
    rpToggle();   // 自动播放
}
function closeReplay() {
    if (rpTimer) { clearTimeout(rpTimer); rpTimer = null; }
    rpPlaying = false;
    document.getElementById('replay-overlay').style.display = 'none';
}
function renderReplayFrame() {
    const f = rpFrames[rpIdx]; if (!f) return;
    const n = f.players.length;
    const meIdx = f.players.findIndex(p => p.isMe);
    const base = meIdx >= 0 ? meIdx : 0;
    document.getElementById('rp-ring').innerHTML = f.players.map((p, i) => {
        const ri = ((i - base) % n + n) % n;
        const pos = rpRingPos(ri, n);
        const showFace = p.isMe || p.showCards;
        const cards = p.hole.map(c => (showFace && c) ? formatCard(c) : cardBack()).join('');
        const cls = 'rp-seat' + (p.folded ? ' folded' : '') + (p.userId === f.actingId ? ' acting' : '');
        const initial = (p.name || '?').charAt(0).toUpperCase();
        const av = p.avatar ? `<img src="${escapeHtml(p.avatar)}" onerror="this.style.display='none'">` : escapeHtml(initial);
        return `<div class="${cls}" style="left:${pos.x}%;top:${pos.y}%">
            <div class="rp-cards">${cards}</div>
            <div class="rp-avatar" style="background:hsl(${hashHue(p.userId)},45%,42%)">${av}</div>
            <div class="rp-name"><span class="rp-nm">${escapeHtml(p.name)}</span>${
                p.pos ? `<span class="pos">${p.pos}</span>` : ''}</div>
            <div class="rp-stack">${fmtChips(p.stack)}</div>
            ${p.bet > 0 ? `<div class="rp-bet">${fmtChips(p.bet)}</div>` : ''}
        </div>`;
    }).join('');
    let cc = '';
    const commEl = document.getElementById('rp-community');
    if (f.boards) {   // 多次发牌总览：每一次一行
        cc = f.boards.map((bd, i) => `<div class="rp-run"><span class="rp-run-no">${L(`第${i + 1}次`, `#${i + 1}`)}</span>${bd.map(c => formatCard(c)).join('')}</div>`).join('');
    } else {
        const src = f.board || rpCommunity;   // 多次发牌的某一次：用那一次的公共牌
        for (let i = 0; i < 5; i++) cc += (i < f.community && src[i]) ? formatCard(src[i]) : emptySlot();
    }
    commEl.classList.toggle('runs', !!f.boards);
    commEl.innerHTML = cc;
    // 与牌桌同一个筹码图标（原来是 💰 emoji，牌桌换成 CSS 筹码后回放没跟上）
    document.getElementById('rp-pot').innerHTML = '<span class="chip gold"></span>' + L('底池 ', 'Pot ') + escapeHtml(String(fmtChips(f.pot)));
    document.getElementById('rp-caption').textContent = f.caption || '';
    document.getElementById('rp-progress').textContent = `${rpIdx + 1}/${rpFrames.length}`;
}
function rpToggle() {
    rpPlaying = !rpPlaying;
    setIconLabel(document.getElementById('rp-play'), rpPlaying ? 'pause' : 'play');
    if (rpPlaying) rpAdvanceLoop(); else if (rpTimer) { clearTimeout(rpTimer); rpTimer = null; }
}
function rpAdvanceLoop() {
    if (!rpPlaying) return;
    if (rpIdx >= rpFrames.length - 1) { rpPlaying = false; setIconLabel(document.getElementById('rp-play'), 'play'); return; }
    rpTimer = setTimeout(() => { rpIdx++; renderReplayFrame(); rpAdvanceLoop(); }, 1300 / RP_SPEEDS[rpSpeedIdx]);
}
function rpStep(dir) {
    rpPlaying = false; setIconLabel(document.getElementById('rp-play'), 'play');
    if (rpTimer) { clearTimeout(rpTimer); rpTimer = null; }
    rpIdx = Math.max(0, Math.min(rpFrames.length - 1, rpIdx + dir));
    renderReplayFrame();
}
function rpSpeed() {
    rpSpeedIdx = (rpSpeedIdx + 1) % RP_SPEEDS.length;
    document.getElementById('rp-speed').textContent = RP_SPEEDS[rpSpeedIdx] + '×';
}

// 把这一手的完整牌谱复制出去，给 tools/verify-hand.js 离线验算用。
// 🔴 必须是【整份牌谱】而不只是种子：验算器第三步要核对
// 「重算出来的牌序能不能解释你当时真的看到的牌」，那需要 seats 和 community。
// （先前公平性面板里写着「去牌谱回顾里导出」，可那个入口根本不存在 ——
//  说明书叫人去做一件做不到的事，比没有说明书更糟。）
function copyHandForVerify() {
    if (!curDetailHand) return;
    if (!curDetailHand.fair) {
        toast(L('这手牌没有公平性数据（2026-09-16 之前的牌没有）',
            'This hand has no fairness data (hands before 2026-09-16 do not have it)'));
        return;
    }
    // 桌子还没散：种子没下发（否则等于公开弃牌者从未亮过的底牌）。
    // 导了也验不了，不如当场说清楚 —— 让人拿着残缺数据去跑工具更糟。
    if (curDetailHand.fair.revealPending) {
        toast(L('本桌还在进行中，种子要等整桌结束后才公开（否则等于公开别人弃掉的牌）。',
            'This table is still running. Seeds are published after the table ends '
            + '(otherwise it would expose cards other players folded).'));
        return;
    }
    copyText(JSON.stringify(curDetailHand, null, 2), L('已复制验证数据', 'Verification data copied'));
}

// ===== 示例牌局（2026-11-17）=====
// 一个人点进来、没有朋友在线时，开了桌也是空桌 —— 看不到游戏最好看的那部分。
// 这里放一手写死的牌，用现成的回放界面播出来；登录页上（还没有账号）也能看。
// 名字都是虚构的。数字是自洽的：各家投入加起来 = 底池 20,150，赢家拿走的也是 20,150
// （guest.test.js 里有一条断言守着，改牌的时候别把账改歪）。
function demoHand() {
    const seat = (i, username, hole, avatar) => ({
        userId: 'demo-' + i, username, seat: i, avatar: '/avatars/b' + avatar + '.svg', startChips: 10000, hole });
    const act = (street, i, action, amount, thinkMs) => ({ street, userId: 'demo-' + i, action, amount, thinkMs });
    return {
        ts: Date.now(), mode: 'cash', sb: 50, bb: 100, ante: 0,
        heroId: 'demo-0', buttonUserId: 'demo-0',
        seats: [
            seat(0, 'Mika', ['AS', 'KS'], 3), seat(1, 'Yuki', ['9C', '4D'], 8), seat(2, 'Sam', ['JH', '6C'], 12),
            seat(3, 'Leo', ['8D', '3H'], 17), seat(4, 'Ana', ['QH', 'QD'], 21), seat(5, 'Tom', ['TC', '5H'], 26),
        ],
        community: ['KD', '7S', '2S', 'QC', '5S'],
        actions: [
            act('preflop', 3, 'fold', 0, 2100), act('preflop', 4, 'raise', 250, 3400), act('preflop', 5, 'fold', 0, 1500),
            act('preflop', 0, 'raise', 800, 6200), act('preflop', 1, 'fold', 0, 1800), act('preflop', 2, 'fold', 0, 2600),
            act('preflop', 4, 'call', 800, 9100),
            act('flop', 4, 'check', 0, 3000), act('flop', 0, 'bet', 900, 5200), act('flop', 4, 'call', 900, 7400),
            act('turn', 4, 'check', 0, 4100), act('turn', 0, 'bet', 2400, 8800),
            act('turn', 4, 'raise', 8300, 12500), act('turn', 0, 'call', 8300, 15200),
        ],
        results: [
            { userId: 'demo-0', won: 20150, endChips: 20150 }, { userId: 'demo-1', won: 0, endChips: 9950 },
            { userId: 'demo-2', won: 0, endChips: 9900 }, { userId: 'demo-3', won: 0, endChips: 10000 },
            { userId: 'demo-4', won: 0, endChips: 0 }, { userId: 'demo-5', won: 0, endChips: 10000 },
        ],
    };
}
function openDemoHand() { openReplay(demoHand()); }

// ===== 牌谱分享（2026-11-17）=====
// 分两步：先拿链接、显示在一行里，再点「复制」/「分享到…」。
// 不能一点就直接复制：拿链接要等服务器，而 Safari 等浏览器要求复制/系统分享发生在【用户这一下点击里】，
// 等完网络请求这一下就过期了，复制会静默失败。第二次点击是新的一下，稳。
async function shareCurrentHand() {
    const h = curDetailHand;
    if (!h || !h.handId) return;
    let data = {};
    try {
        const r = await fetch('/api/hands/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ handId: h.handId })
        });
        data = await r.json().catch(() => ({}));
        if (!r.ok || !data.token) throw data;
    } catch (e) {
        toast(apiErr(e, '生成分享链接失败', 'Could not create a share link'));
        return;
    }
    document.getElementById('hd-share-url').value = location.origin + '/#/hand/' + data.token;
    document.getElementById('hd-share-native').style.display = navigator.share ? '' : 'none';
    document.getElementById('hd-share-row').style.display = '';
}
function copyShareUrl() {
    copyText(document.getElementById('hd-share-url').value,
        L('已复制，发给朋友就能看这一手的回放（不用登录）', 'Copied — anyone with the link can watch this hand (no login needed)'));
}
function nativeShare() {
    const url = document.getElementById('hd-share-url').value;
    if (!navigator.share || !url) return;
    navigator.share({ title: L('德扑道场 · 一手牌', 'Poker Dojo · a hand'), url }).catch(() => {});   // 用户取消也会进这里，不提示
}
// 点分享链接进来：拉那一手（服务端已经过滤成分享人当时看得见的样子）直接放回放
async function openSharedHand(token) {
    try {
        const r = await fetch('/api/shared-hand/' + encodeURIComponent(token));
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.hand) throw data;
        rememberShareRef(token);       // 没登录的人：记下是哪条分享带他来的（之后建号时一起报上去）
        openReplay(data.hand);
    } catch (e) {
        toast(apiErr(e, '这个分享链接已失效', 'This share link is no longer available'), 4000);
    }
}
// 回放下方的「自己也来玩」：关掉回放，光标落到登录页的昵称框（填个昵称就能进）
function ctaPlay() {
    closeReplay();
    const inp = document.getElementById('guest-name');
    if (inp) { inp.focus(); inp.select && inp.select(); }
}
