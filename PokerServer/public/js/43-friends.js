// ===== 牌友（2026-09-13，第 1 批）=====
// 产品名叫「好友开房」，但在此之前没有好友：想一起玩只能「房主复制房间码 →
// 切到微信发 → 对方切回来输码」，每局重来一遍。
//
// 这一批只做 列表 + 双向确认 + 备注 + 「上次一起玩的人」；一键邀请放第二批。
// ⚠️ 备注是【私有】的 —— 服务端只写我那一行、也不推给对方。前端同样不显示
//    「对方给我的备注」这种东西（根本拿不到）。

// 状态变量在 00-state.js 里声明（跨文件引用的东西必须放在最先加载的那份）

function openFriends() {
    // ⚠️ 必须是 ''（交给 CSS），不能写 'flex'。
    //    .side-panel 没声明 display，默认 block；写成 flex 就变成【横向】弹性容器，
    //    头部/标签/内容被并排挤成一条条竖字（实拍过）。收件箱/战绩/牌谱都是 ''。
    document.getElementById('friends-panel').style.display = '';
    friendTab = 'friends';
    friendSearch = null;
    const si = document.getElementById('fr-search');
    if (si) si.value = '';
    renderFriends();
    socket?.emit('friend_list');
    socket?.emit('friend_recent');
    socket?.emit('friend_h2h');
}
function closeFriends() { document.getElementById('friends-panel').style.display = 'none'; }

function setFriendTab(tab) { friendTab = tab; renderFriends(); }

// 在线状态：离线 / 在大厅 / 在牌桌。在牌桌的人才是「现在能约的」，所以单独标出来。
function presenceHtml(f) {
    if (!f.online) return `<span class="fr-dot off"></span>${L('离线', 'Offline')}`;
    if (f.roomId) return `<span class="fr-dot playing"></span>${L('牌桌中', 'At a table')}`;
    return `<span class="fr-dot on"></span>${L('在线', 'Online')}`;
}

function friendAvatar(f) {
    const ltr = escapeHtml((String(f.displayName || '?').trim()[0] || '?').toUpperCase());
    return f.avatar
        ? `<img src="${escapeHtml(f.avatar)}" alt="">`
        : `<span class="fr-ltr">${ltr}</span>`;
}

// 一行 = 三层，【横向谁都不跟谁抢】：
//   上：头像 + 名字/备注/在线状态（独占整行宽度）
//   中：对战战绩（整行）
//   下：按钮（右对齐）
// 🔴 为什么不再挤成一行：原来是「左头像 + 中信息 + 右按钮」，而 .fr-acts 是
//    flex-shrink:0 的三个按钮 —— 名字被压成「ad⋯」，我又往 .fr-sub 里塞了一长串
//    对战数据，文字直接从按钮底下穿过去（玩家两端实拍）。
//    **这和「备注塞进截断的名字行」是同一类错：把长度不受控的内容，放进一个
//    为短内容设计的位置。** 分层之后这类错在结构上就没地方发生了。
function friendRow(f, actions) {
    const note = f.note ? `<div class="fr-note">${escapeHtml(f.note)}</div>` : '';
    return `<div class="fr-row">
        <div class="fr-top">
            <div class="fr-av">${friendAvatar(f)}</div>
            <div class="fr-main">
                <div class="fr-name">${escapeHtml(f.displayName)}</div>
                ${note}
                <div class="fr-sub">${actions.sub || ''}</div>
            </div>
        </div>
        ${actions.h2h || ''}
        ${actions.buttons ? `<div class="fr-acts">${actions.buttons}</div>` : ''}
    </div>`;
}

function renderFriends() {
    const box = document.getElementById('friends-body');
    if (!box) return;
    document.querySelectorAll('#friends-panel .fr-tab')
        .forEach(b => b.classList.toggle('sel', b.dataset.ft === friendTab));

    let html = '';

    // 搜索结果置顶：它是玩家刚手动触发的，该第一眼看到
    if (friendSearch) {
        html += `<div class="fr-sec">${L('搜索结果', 'Search result')}</div>`;
        if (friendSearch.self) {
            html += `<div class="pane-empty">${L('这是你自己', 'That\'s you')}</div>`;
        } else if (friendSearch.notFound != null) {
            html += `<div class="pane-empty">${L('没找到这个人<br>牌友号要填完整的 8 位，用户名要完全一致',
                'No match<br>Enter the full 8-digit code, or the exact username')}</div>`;
        } else {
            const f = friendSearch.found;
            const btn = f.status === 'accepted'
                ? `<span class="ap-friend-tag">${L('✓ 已是牌友', '✓ Friends')}</span>`
                : f.status === 'pending'
                    ? `<span class="ap-friend-tag">${L('已发申请', 'Request sent')}</span>`
                    : f.status === 'incoming'
                        ? `<button class="fr-btn ok" onclick="respondFriend('${f.userId}',true)">${L('同意', 'Accept')}</button>`
                        : `<button class="fr-btn ok" onclick="requestFriend('${f.userId}')">${L('加牌友', 'Add')}</button>`;
            html += friendRow(f, { sub: `${L('牌友号', 'Code')} ${escapeHtml(f.friendCode)} · ` + presenceHtml(f), buttons: btn });
        }
    }

    // 待处理的申请置顶：它需要我做决定，压在列表下面等于没提醒
    if (friendData.incoming.length) {
        html += `<div class="fr-sec">${L('待处理的申请', 'Pending requests')}</div>`;
        html += friendData.incoming.map(f => friendRow(f, {
            sub: L('想加你为牌友', 'wants to be your poker friend'),
            buttons: `<button class="fr-btn ok" onclick="respondFriend('${f.userId}',true)">${L('同意', 'Accept')}</button>`
                   + `<button class="fr-btn" onclick="respondFriend('${f.userId}',false)">${L('拒绝', 'Decline')}</button>`,
        })).join('');
    }

    if (friendTab === 'friends') {
        const list = friendData.friends;
        if (!list.length && !friendData.incoming.length) {
            html += `<div class="pane-empty"><span class="pe-ico">👥</span>${
                L('还没有牌友<br>去「一起玩过」里把老对手加上，下次开局直接找他们',
                  'No poker friends yet<br>Add past opponents from “Played with” — then just ping them next time')}</div>`;
        } else if (list.length) {
            html += `<div class="fr-sec">${L('我的牌友', 'My friends')} (${list.length})</div>`;
            html += list.map(f => friendRow(f, {
                sub: presenceHtml(f),
                h2h: h2hHtml(f.userId),
                buttons: `<button class="fr-btn" onclick="editFriendNote('${f.userId}')">${L('备注', 'Note')}</button>`
                       + `<button class="fr-btn danger" onclick="removeFriend('${f.userId}')">${L('删除', 'Remove')}</button>`
                       + `<button class="fr-btn danger" title="${L('拉黑', 'Block')}" onclick="blockFriend('${f.userId}')">🚫</button>`,
            })).join('');
        }
        // 已拉黑单独一组、放在最后：没有「解除」的入口，拉黑就是个陷阱。
        if (friendData.blocked?.length) {
            html += `<div class="fr-sec">${L('已拉黑', 'Blocked')} (${friendData.blocked.length})</div>`;
            html += friendData.blocked.map(f => friendRow(f, {
                sub: L('无法向你发送牌友申请', 'Cannot send you friend requests'),
                buttons: `<button class="fr-btn" onclick="unblockFriend('${f.userId}')">${L('解除', 'Unblock')}</button>`,
            })).join('');
        }
        if (friendData.outgoing.length) {
            html += `<div class="fr-sec">${L('已发出的申请', 'Sent requests')}</div>`;
            html += friendData.outgoing.map(f => friendRow(f, {
                sub: L('等待对方同意', 'Waiting for them to accept'),
                buttons: `<button class="fr-btn" onclick="removeFriend('${f.userId}')">${L('取消', 'Cancel')}</button>`,
            })).join('');
        }
    } else {
        // 「一起玩过」：纯从牌谱算出来的，已排除掉已有关系的人
        if (!friendRecent.length) {
            html += `<div class="pane-empty"><span class="pe-ico">🃏</span>${
                L('最近没有一起打过牌的人', 'Nobody you have played with recently')}</div>`;
        } else {
            html += `<div class="fr-sec">${L('最近一起打过牌', 'Recently played with')}</div>`;
            html += friendRecent.map(f => friendRow(f, {
                sub: L(`最近同桌 ${f.handsTogether} 手 · `, `${f.handsTogether} hands together · `) + presenceHtml(f),
                buttons: `<button class="fr-btn ok" onclick="requestFriend('${f.userId}')">${L('加牌友', 'Add')}</button>`,
            })).join('');
        }
    }
    box.innerHTML = html;
}

function requestFriend(userId) { socket?.emit('friend_request', { userId }); }
function respondFriend(userId, accept) { socket?.emit('friend_respond', { userId, accept }); }
function removeFriend(userId) {
    const f = friendData.friends.find(x => x.userId === userId);
    // 没在好友列表里 = 取消一条自己发出的申请，不必再确认一次
    if (!f) { socket?.emit('friend_remove', { userId }); return; }
    uiConfirm(L(`确定删除牌友「${f.displayName}」？`, `Remove ${f.displayName} from your friends?`), { danger: true })
        .then(ok => { if (ok) socket?.emit('friend_remove', { userId }); });
}
// 备注弹窗：不用浏览器 prompt()。
// prompt 在手机 WebView 里会被限制甚至直接不弹，而且顶着一行「来自网页的提示」，
// 观感上很像钓鱼弹窗 —— 自家应用里的输入不该长成那样。
let _noteTarget = null;
function editFriendNote(userId) {
    const f = friendData.friends.find(x => x.userId === userId);
    if (!f) return;
    _noteTarget = userId;
    document.getElementById('note-who').textContent = f.displayName;
    const input = document.getElementById('note-input');
    input.value = f.note || '';
    document.getElementById('note-modal').style.display = 'flex';
    setTimeout(() => input.focus(), 50);
}
function closeNoteModal() { _noteTarget = null; document.getElementById('note-modal').style.display = 'none'; }
function saveFriendNote() {
    if (!_noteTarget) return;
    socket?.emit('friend_note', { userId: _noteTarget, note: document.getElementById('note-input').value });
    closeNoteModal();
}

// 牌友数（含待处理申请）挂到「我的」那一行和导航红点上，不然玩家不会想起来点开
function refreshFriendBadge() {
    const pending = friendData.incoming.length;
    const b = document.getElementById('friends-badge');
    if (b) {
        b.textContent = pending > 9 ? '9+' : pending;
        b.style.display = pending > 0 ? '' : 'none';
    }
    if (typeof refreshMeDot === 'function') refreshMeDot();
}

// 打开时 display 是 ''（交给 CSS），所以只能判「不是 none」，
// 写 === 'flex' 永远不成立（上一版就是这么错的）。
onLangChange(() => {
    if (document.getElementById('friends-panel')?.style.display !== 'none') renderFriends();
    renderFriendsOnline();
});

// 搜索加好友。只认精确匹配（牌友号或用户名），所以不做输入即搜，按回车/点按钮才发。
function doFriendSearch() {
    const q = (document.getElementById('fr-search').value || '').trim();
    if (!q) { friendSearch = null; renderFriends(); return; }
    socket?.emit('friend_search', { q });
}
function copyMyCode() {
    copyText(myFriendCode, L('牌友号已复制', 'Friend code copied'));
}

// ===== 一键邀请（第 2 批）=====
// 只列【在大厅】的牌友：正在别的牌桌的人服务端也会拒（不该把人从一手牌里拽走），
// 与其让房主点了才知道，不如根本不显示。
// ⚠️ 这个列表只在房主的邀请弹窗里出现，而真正的闸在服务端 invite_friend 的
//    ownerUserId 校验 —— 客户端这层只是别让人看见按钮。
// 人多时才出现筛选框的门槛。低于它多一个输入框只是碍事。
const INV_FILTER_AT = 8;
function renderInviteFriends() {
    const box = document.getElementById('invite-friends');
    if (!box) return;
    const all = friendData.friends.filter(f => f.online && !f.roomId);

    // ⚠️ 筛选框写在 index.html 里、【不在重渲染的那块 DOM 内】——
    //    否则每敲一个字就把 input 重建一次，光标当场丢掉。
    const fi = document.getElementById('inv-fr-filter');
    if (fi) {
        fi.style.display = all.length >= INV_FILTER_AT ? '' : 'none';
        if (all.length < INV_FILTER_AT) fi.value = '';
    }
    const q = (fi?.value || '').trim().toLowerCase();
    const list = q ? all.filter(f => String(f.displayName || '').toLowerCase().includes(q)) : all;

    // 计数单独一个 span：外面那个标签挂着 data-i18n，JS 一写就会被 applyLang() 覆盖回去
    const cnt = document.getElementById('inv-fr-count');
    if (cnt) cnt.textContent = all.length ? (q ? ` ${list.length}/${all.length}` : ` (${all.length})`) : '';

    if (q && !list.length) {
        box.innerHTML = `<div class="pane-empty">${L('没有匹配的牌友', 'No friend matches that')}</div>`;
        return;
    }
    if (!list.length) {
        box.innerHTML = `<div class="pane-empty">${L('现在没有在大厅的牌友<br>已经在别的牌桌上的人不能被邀请',
            'No friends in the lobby right now<br>Friends already at a table cannot be invited')}</div>`;
        return;
    }
    box.innerHTML = list.map(f => `<div class="inv-fr">
        <div class="fr-av">${friendAvatar(f)}</div>
        <div class="fr-name">${escapeHtml(f.displayName)}</div>
        <button class="fr-btn ok" onclick="inviteFriend('${f.userId}')">${L('邀请', 'Invite')}</button>
    </div>`).join('');
}
// 结果一律由服务端的 server_msg 告诉他（已邀请 / 不是牌友 / 在别桌 / 入场锁着…），
// 这里不预判 —— 客户端猜出来的结论和服务端不一致时，玩家只会更糊涂。
function inviteFriend(userId) { socket?.emit('invite_friend', { userId }); }

// 大厅「N 位牌友在线」。约局的第一步永远是「有没有人」——
// 这条信息原来只藏在「我的」→ 牌友里，等于要先想起来找它。
// 只在【真有人在线】时才显示：没人时挂一行「0 位在线」是纯噪音。
const FO_MAX_AV = 6;
function renderFriendsOnline() {
    const box = document.getElementById('friends-online');
    if (!box) return;
    const on = friendData.friends.filter(f => f.online);
    if (!on.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    const avs = on.slice(0, FO_MAX_AV).map(f => `<span class="fo-av">${friendAvatar(f)}</span>`).join('');
    const more = on.length > FO_MAX_AV ? `<span class="fo-more">+${on.length - FO_MAX_AV}</span>` : '';
    box.innerHTML = `<span class="fo-dot"></span>`
        + `<span class="fo-text">${L(`${on.length} 位牌友在线`, `${on.length} friend${on.length > 1 ? 's' : ''} online`)}</span>`
        + `<span class="fo-avs">${avs}${more}</span><span class="fo-go">\u203a</span>`;
}

// 拉黑 / 解除。二次确认写清楚后果 —— 「拉黑」这个词在不同产品里含义差很多，
// 别让玩家靠猜。
function blockFriend(userId) {
    const f = friendData.friends.find(x => x.userId === userId)
        || friendData.blocked.find(x => x.userId === userId) || { displayName: '' };
    uiConfirm(L(`拉黑「${f.displayName}」？会解除牌友关系，并且他之后无法再向你发送申请。`,
                `Block ${f.displayName}? This removes them as a friend and stops them sending you requests.`),
        { ok: L('拉黑', 'Block'), danger: true })
        .then(ok => { if (ok) socket?.emit('friend_block', { userId }); });
}
function unblockFriend(userId) { socket?.emit('friend_unblock', { userId }); }

// 对战战绩：我和 TA【同桌过的那些手】里，双方各自净多少。
// ⚠️ 措辞不能写成「我赢了他多少」—— 多人桌上我赢的钱大半来自别人，
//    那个数这张表根本算不出来。能说的是「同一批手里各自的成绩」，那也正是想比的东西。
// 只算现金桌：SNG 是锦标赛记分牌，和现金筹码混在一起这个数就没意义了。
function h2hHtml(userId) {
    const h = friendH2H[userId];
    if (!h || !h.handsTogether) return '';
    const sign = n => (n > 0 ? '+' : '') + fmtChips(n);
    const cls = n => (n > 0 ? 'h2h-up' : n < 0 ? 'h2h-down' : '');
    return `<div class="fr-h2h">`
        + `<span class="fr-h2h-n">${L(`同桌 ${h.handsTogether} 手`, `${h.handsTogether} hands`)}</span>`
        + `<span>${L('我', 'me')} <b class="${cls(h.myNet)}">${sign(h.myNet)}</b></span>`
        + `<span>${L('TA', 'them')} <b class="${cls(h.theirNet)}">${sign(h.theirNet)}</b></span></div>`;
}
