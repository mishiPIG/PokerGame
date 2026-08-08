// ===== Socket =====
function connectSocket(token) {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('connect', () => {
        const saved = localStorage.getItem('currentRoom');
        let pendingInvite = pendingInviteToken;
        if (!pendingInvite) {
            try { pendingInvite = sessionStorage.getItem('pendingInviteToken') || ''; } catch {}
        }
        hideReconnecting();
        if (pendingInvite) {
            // 邀请优先于旧房间恢复，防止用户点新邀请却被带回上一次牌桌。
            showLobby();
            socket.emit('join_by_invite', { token: pendingInvite });
        } else if (everConnected && saved) {
            // 断线重连：直接回房，不闪回大厅（避免「弹回主界面再进来」的观感）
            socket.emit('join_room', { roomId: saved });
        } else {
            showLobby();                               // 首次连接/无房：进大厅（会清掉 currentRoom 记录）
            if (saved) socket.emit('join_room', { roomId: saved });
        }
        everConnected = true;
    });
    socket.on('disconnect', () => { if (sessionKicked) return; showReconnecting(); });   // 断线：显示「重连中」而非弹回大厅

    // 单会话：账号在别处（新页面/设备）打开 → 此页停止重连并提示，避免两页互相踢的死循环
    socket.on('session_kicked', (m) => {
        sessionKicked = true;
        try { socket.io.opts.reconnection = false; } catch {}   // 关掉自动重连（否则会反过来把新页面踢下线）
        try { socket.disconnect(); } catch {}
        showKickedNotice(m && m.reason);
    });

    socket.on('connect_error', (err) => {
        localStorage.removeItem('token');
        document.getElementById('auth-overlay').style.display = 'flex';
        document.getElementById('game-section').style.display = 'none';
        setAuthError(err.message || '连接失败，请重新登录');
    });

    socket.on('server_msg', (msg) => {
        console.log('[server]', msg);   // 动作播报（下注/跟注/弃牌…）仅开发调试，不显示在桌面
        // ⚠️ 开头的都是服务端对「我」的私发拒绝（非法操作/不是你的回合/筹码不足/无效加注…），
        // 以前只进 console → 玩家点了没反应还以为按钮坏了。这类必须可见。
        if (typeof msg === 'string' && msg.startsWith('⚠️')) toast(msg, 3000);
    });

    socket.on('room_list', (rooms) => {
        renderRoomList(rooms);
    });

    socket.on('room_joined', ({ roomId, canPlay }) => {
        pendingInviteToken = '';
        try { sessionStorage.removeItem('pendingInviteToken'); } catch {}
        currentRoom = roomId;
        iCanPlay = !!canPlay;   // 观战者=false → 禁止入座
        localStorage.setItem('currentRoom', roomId);
        resetJoinCode(true);   // 复位四格房间码
        hideReconnecting();
        document.getElementById('btnReady').disabled = false;
        showTable();
        socket.emit('voice_sync', roomId);
    });

    socket.on('invite_error', ({ source, message }) => {
        if (source === 'link') {
            pendingInviteToken = '';
            try { sessionStorage.removeItem('pendingInviteToken'); } catch {}
        }
        resetJoinCode(source !== 'link');   // 输错房间码→清空四格重输（链接失败不清）
        showLobby();
        toast(message || '房间不存在或当前不可加入', 3500);
    });

    socket.on('room_invite_info', (info) => {
        roomInviteInfo = info;
        renderInviteInfo();
        if (info.autoOpen) openInvite(false);
    });

    socket.on('left_room', () => {
        showLobby();
    });

    socket.on('room_dissolved', () => {
        showLobby();
    });

    socket.on('busted_out', () => {
        setTimeout(() => { alert('你已离开牌桌'); showLobby(); }, 300);
    });

    // SNG 被淘汰：不再踢回大厅，留在桌上继续观战（想走点「退出房间」即可）
    socket.on('eliminated', ({ canSpectate } = {}) => {
        if (!canSpectate) { setTimeout(() => { alert('你已出局'); showLobby(); }, 300); return; }
        toast('💀 你已出局，可继续观战；想离开点「退出房间」', 4500);
        showTableNotice('💀 你已出局，正在观战');
    });

    // 按 userId 判断夺冠（不用用户名——显示名可改，id 才稳定）
    socket.on('tournament_over', ({ winnerId }) => {
        if (winnerId === myUserId) setTimeout(() => sndWin(), 1500);   // 夺冠音；排名由 match_result 弹窗展示
    });

    // 比赛结束排名（现金桌训练结束/房主结束/SNG 结束）：弹结算面板
    socket.on('match_result', ({ title, ranking }) => {
        setTimeout(() => {
            const me = (ranking || []).find(r => r.userId === myUserId);
            document.getElementById('result-title').textContent = title || '比赛结束';
            document.getElementById('result-sub').innerHTML = me
                ? `你排名 <b>第 ${me.rank}</b> / ${ranking.length}，盈亏 <b>${me.net >= 0 ? '+' : ''}${me.net}</b> ${me.unit}`
                : '';
            document.getElementById('result-ranking').innerHTML = (ranking || []).map(r =>
                `<div class="rk-row${r.userId === myUserId ? ' me' : ''}">
                    <span class="rk-no">${r.rank}</span>
                    <span class="rk-name">${escapeHtml(r.displayName || r.username)}</span>
                    <span class="rk-net" style="color:${r.net >= 0 ? '#4ade80' : '#f87171'}">${r.net >= 0 ? '+' : ''}${r.net} ${r.unit}</span>
                </div>`).join('');
            document.getElementById('result-overlay').style.display = 'flex';
            if (me && me.rank === 1) sndWin();
            refreshInboxBadge();
        }, 1500);
    });

    socket.on('hole_cards', (cards) => {
        myHoleCards = cards;
        revealedCards = {};  // 新一局清除 showdown 展示
        showdownInfo = null; myHand = null;
        shownCards = {}; myShown = new Set();  // 清除上一局主动亮牌
        hideRunitPanel(); clearRunit();        // 新一局：清多次发牌协商面板 + 桌面 N 板残留（防公共牌被 runit-on 一直藏着）
        holeJustDealt = true;  // 发牌动画在随后的 game_state(preflop) 渲染时统一播放（我的牌 + 对手牌背交替飞入）
        // 发牌音效：依次发 4 张（双方各 2 张），节奏与视觉延迟对齐
        sndDeal(0); sndDeal(1); sndDeal(2); sndDeal(3);
    });

    socket.on('my_hand', (info) => {
        myHand = info;
        if (lastState) render(lastState);
    });

    socket.on('sfx', (type) => playSfx(type));

    // 收到聊天：进聊天列表 + 弹幕滚过屏幕（带 id）
    socket.on('chat_broadcast', ({ userId, displayName, username, text }) => {
        const name = displayName || username || '玩家';
        appendChat(name, text, userId === myUserId);
        spawnDanmaku(name, text);
    });
    // 收到表情：座位上方大表情飘出
    socket.on('emote_broadcast', ({ userId, emote, targetUserId }) => {
        if (targetUserId && targetUserId !== userId) flyEmote(userId, targetUserId, emote);   // 扔给某人：飞过去
        else seatBubble(userId, emote, true);                                                  // 广播：自己头上冒
    });
    socket.on('player_stats', ({ userId, stats }) => renderPlayerStats(userId, stats));
    socket.on('button_draw', ({ draws, winnerId }) => showButtonDraw(draws, winnerId));
    socket.on('table_notice', ({ text }) => showTableNotice(text));   // 公共牌下方一行提示（如"谁想看转牌"）
    socket.on('match_ending_soon', () => {
        const isOwner = lastState && lastState.ownerUserId === myUserId;
        if (isOwner) {
            toast('⏰ 训练时长到！本手结束后比赛结束——可在「比赛设置」加时继续', 5000);
            openMatchSettings();   // 房主：打开比赛设置直接选加时
        } else {
            toast('⏰ 训练时长到，本手结束后比赛结束', 3500);
        }
    });
    // 临时语音不进聊天历史：只在当前房间飘出 10 秒可点击气泡
    socket.on('voice_broadcast', ({ id, userId, displayName, username, durationMs, expiresAt, bubbleUntil }) => {
        showVoiceBubble({ id, userId, username: displayName || username, durationMs, expiresAt, bubbleUntil });
    });

    socket.on('allin_reveal', ({ reveals }) => {
        revealedCards = reveals;       // 全押后双方底牌翻开
        revealJustHappened = true;
        if (lastState) render(lastState);
    });

    // ===== 多次发牌（run it N times）：桌面依次发、每组比牌后飞池给赢家 =====
    socket.on('runit_offer', (o) => showRunitOffer(o));
    socket.on('runit_proposal', (pr) => showRunitProposal(pr));
    socket.on('runit_decided', (d) => { hideRunitPanel(); if (d && d.n > 1) toast(`🎲 本手发 ${d.n} 次`, 2000); });
    socket.on('runit_begin', (m) => {
        hideRunitPanel();
        if (m && m.reveals) { revealedCards = m.reveals; revealJustHappened = true; if (lastState) render(lastState); }
        buildRunitBoards(m);   // 建 N 行（共享底只显示一次，剩余街分行/并列显示）
    });
    socket.on('runit_street', (m) => runitDealStreet(m));   // 逐街发牌到对应行
    socket.on('runit_award', (m) => runitAward(m));         // 该组比完 → 飞池给本组赢家
    socket.on('runit_done', (m) => {
        const t = Object.keys((m && m.totalByUser) || {}).map(id => `${nameOf(id)} +${m.totalByUser[id]}`).join('，');
        if (t) toast(`🎲 发牌结束　${t}`, 3600);
    });

    // 全押跑马实时胜率
    socket.on('equity', (m) => { equityMap = m || {}; if (lastState) renderSeats(lastState); });

    socket.on('show_cards', ({ userId, cards }) => {
        shownCards[userId] = cards;
        showJustHappened = true;
        if (userId !== myUserId) sndShow();   // 对手亮牌音效（自己点的已有反馈）
        if (lastState) render(lastState);
    });

    socket.on('showdown_reveal', (data) => {
        clearRunit();   // 普通摊牌（非多次发牌）→ 清掉上一手多次发牌的桌面残留，避免 runit-on 一直藏住公共牌
        // 兼容旧结构（纯 reveals 对象）与新结构（含牌型高亮）
        if (data && data.reveals) {
            revealedCards = data.reveals;
            showdownInfo = {
                winners: data.winners || [], winnerId: data.winnerId,
                bestCommunity: data.bestCommunity || [], bestHole: data.bestHole || [],
                category: data.category || '', bestByWinner: data.bestByWinner || {}
            };
        } else {
            revealedCards = data; showdownInfo = null;
        }
        revealJustHappened = true;
        equityMap = {};   // 摊牌出结果，胜率清除
        if (lastState) render(lastState);  // 翻牌 + 牌型高亮动画
        // 分池飞币：主池先飞向赢家，边池依次再飞（多人 all-in）
        if (showdownInfo) animatePotsToWinners(data.pots, showdownInfo.winnerId);
    });

    socket.on('gold_update', ({ gold }) => {
        myGold = gold;
        updateUserBar();
    });

    socket.on('profile', ({ avatar, displayName, displayNameChangedAtMs }) => {
        myAvatar = avatar || null;
        if (displayName) { myDisplayName = displayName; updateUserBar(); }
        if (displayNameChangedAtMs != null) myDisplayNameChangedAtMs = displayNameChangedAtMs;
        const o = document.getElementById('settings-overlay');
        if (o && o.style.display !== 'none') buildSettingsPanel();
    });

    socket.on('straddle_offer', (offer) => {
        if (!offer || !offer.targetHandSeq || offer.deadlineAt <= Date.now()) return;
        // 同一邀请在重连恢复时可能再次收到，不重置服务端截止时间。
        straddleOffer = {
            targetHandSeq: offer.targetHandSeq,
            amount: offer.amount,
            deadlineAt: offer.deadlineAt
        };
        clearInterval(straddleOfferTimer);
        renderStraddleOffer();
        straddleOfferTimer = setInterval(renderStraddleOffer, 250);
    });
    socket.on('straddle_decision_result', (result) => {
        if (straddleOffer && result.targetHandSeq !== straddleOffer.targetHandSeq) return;
        hideStraddleOffer();
        if (result.status === 'accepted') toast(`🔥 已选择：下一局 Straddle ${result.amount}`, 2600);
        else if (result.status === 'invalidated') toast('座位或筹码状态变化，Straddle 已取消', 3000);
    });
    socket.on('straddle_posted', ({ userId, amount }) => {
        if (userId === myUserId) toast(`🔥 本局已 Straddle ${amount}`, 2400);
    });

    // 网络延迟测量：每 3s 一次
    socket.on('latency_pong', (t) => {
        const ms = Date.now() - t;
        const el = document.getElementById('latency');
        if (el) {
            el.textContent = `📶 ${ms}ms`;
            el.style.color = ms < 80 ? '#06d6a0' : (ms < 200 ? '#f4d35e' : '#ff5252');
        }
    });
    clearInterval(window._pingTimer);
    window._pingTimer = setInterval(() => { if (socket && socket.connected) socket.emit('latency_ping', Date.now()); }, 3000);
    socket.emit('latency_ping', Date.now());

    socket.on('game_state', (state) => {
        const wasShowdown = lastState && lastState.phase === 'showdown';
        // 我刚入座（观众→在座）：播放坐下音 + 整圈座位旋转入位动画
        const nowSeated = state.players.some(p => p.userId === myUserId);
        if (nowSeated && !mySeated) { sndSit(); triggerSeatRotate(); }
        mySeated = nowSeated;
        // 新一手开始：清除上一手摊牌/亮牌的残留（坐出/未发牌的玩家收不到 hole_cards，必须靠这里清）
        if (state.phase === 'preflop' && lastState && lastState.phase !== 'preflop') {
            revealedCards = {}; showdownInfo = null; shownCards = {}; myShown = new Set();
            preAction = null; equityMap = {};   // 新一手清除预操作 + 胜率
            hideRunitPanel(); clearRunit();       // 清多次发牌协商面板 + 桌面 N 板展示
            if (!state.players.some(p => p.userId === myUserId && !p.folded)) myHoleCards = [];
        }
        // 断线重连若正处协商中：恢复面板（否则错过 offer 事件会看不到）
        if (state.runIt && (!document.getElementById('runit-panel') || document.getElementById('runit-panel').style.display === 'none')) {
            showRunitOffer(state.runIt);
        }
        const prevBets = {};
        if (lastState) lastState.players.forEach(p => prevBets[p.userId] = p.currentBet);
        lastState = state;
        render(state);
        // 公共牌隐藏与否只跟随「是否正在多次发牌」(runitState)——即便某次清理被漏掉，下一个 state 也会自愈，
        // 杜绝「上一手多次发牌的 runit-on 残留把这一手公共牌一直藏住」的 bug。
        document.getElementById('board').classList.toggle('runit-on', !!runitState);
        // 面板打开时随状态实时刷新
        if (document.getElementById('stats-panel').style.display !== 'none') renderStats(state);
        if (document.getElementById('match-modal').style.display !== 'none') renderMatchInfo(state);
        // 收注：本次下注归零（之前 >0）的玩家，金币飞向底池
        const pot = document.getElementById('pot');
        state.players.forEach(p => {
            if ((prevBets[p.userId] || 0) > 0 && p.currentBet === 0) {
                flyCoins(document.querySelector(`.seat[data-uid="${p.userId}"]`), pot, 2);
            }
        });
        // 弃牌获胜（非摊牌）：唯一未弃牌者获得底池，金币飞向他
        if (state.phase === 'showdown' && !wasShowdown) {
            const alive = state.players.filter(p => !p.folded);
            if (alive.length === 1) setTimeout(() => flyCoinsToWinner(alive[0].userId), 400);
        }
    });
}
