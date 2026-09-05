// ===== 临时语音（本地磁盘 1h TTL，无历史）=====
const VOICE_MAX_MS = 14500; // 给媒体封装收尾留余量，服务端按实际媒体时长严格限制 15s
const VOICE_BUBBLE_MS = 10000;
let voiceHold = false;
let voiceCancel = false;
let voiceStartY = 0;
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceStartedAt = 0;
let voiceShouldSend = false;
let voiceMaxTimer = null;
let voiceTickTimer = null;
let voiceUploading = false;
let playingVoice = null;
let voicePlayController = null;
let voicePlayRequestId = 0;
const activeVoiceBubbles = new Map();

function voiceStatus(text, cancel = false) {
    const el = document.getElementById('voice-recording');
    el.textContent = text;
    el.classList.toggle('cancel', cancel);
    el.style.display = 'block';
}

function hideVoiceStatus() {
    const el = document.getElementById('voice-recording');
    el.style.display = 'none';
    el.classList.remove('cancel');
}

function supportedVoiceMime() {
    const choices = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return choices.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function stopVoiceTracks() {
    if (voiceStream) voiceStream.getTracks().forEach(t => t.stop());
    voiceStream = null;
}

function clearVoiceTimers() {
    clearTimeout(voiceMaxTimer); clearInterval(voiceTickTimer);
    voiceMaxTimer = null; voiceTickTimer = null;
}

async function beginVoiceRecording(e) {
    if (!currentRoom || voiceUploading || voiceRecorder || e.button > 0) return;
    if (!voiceSupported()) {
        toast(window.isSecureContext ? L('当前设备不支持语音录制', 'Voice recording not supported on this device') : L('语音需 HTTPS 环境，正式版可用', 'Voice needs HTTPS — available in the release build')); return;
    }
    e.preventDefault();
    voiceHold = true; voiceCancel = false; voiceStartY = e.clientY;
    const btn = document.getElementById('voice-btn');
    try { btn.setPointerCapture(e.pointerId); } catch {}
    btn.classList.add('recording');
    voiceStatus('正在请求麦克风…');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        if (!voiceHold) { stream.getTracks().forEach(t => t.stop()); hideVoiceStatus(); return; }
        voiceStream = stream;
        const mimeType = supportedVoiceMime();
        try {
            voiceRecorder = mimeType
                ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 })
                : new MediaRecorder(stream);
        } catch {
            voiceRecorder = new MediaRecorder(stream);
        }
        voiceChunks = [];
        voiceRecorder.ondataavailable = ev => { if (ev.data?.size) voiceChunks.push(ev.data); };
        voiceRecorder.onerror = () => finishVoiceRecording(false);
        voiceRecorder.onstop = completeVoiceRecording;
        voiceStartedAt = Date.now();
        voiceRecorder.start(250);
        voiceStatus('🎤 0:00  松开发送 · 上滑取消');
        voiceTickTimer = setInterval(() => {
            const sec = Math.min(15, Math.floor((Date.now() - voiceStartedAt) / 1000));
            voiceStatus(voiceCancel ? '松开取消' : `🎤 0:${String(sec).padStart(2, '0')}  松开发送 · 上滑取消`, voiceCancel);
        }, 200);
        voiceMaxTimer = setTimeout(() => {
            voiceHold = false; voiceCancel = false; finishVoiceRecording(true);
        }, VOICE_MAX_MS);
    } catch (err) {
        voiceHold = false; btn.classList.remove('recording'); hideVoiceStatus(); stopVoiceTracks();
        toast(err?.name === 'NotAllowedError' ? L('需要允许麦克风权限才能发送语音', 'Allow microphone access to send voice') : L('无法启动麦克风，请稍后重试', 'Could not start the microphone, try again'));
    }
}

function moveVoiceRecording(e) {
    if (!voiceHold) return;
    voiceCancel = e.clientY < voiceStartY - 55;
}

function releaseVoiceRecording(e) {
    if (!voiceHold) return;
    e.preventDefault();
    voiceHold = false;
    finishVoiceRecording(!voiceCancel);
}

function finishVoiceRecording(send) {
    voiceShouldSend = !!send;
    clearVoiceTimers();
    document.getElementById('voice-btn')?.classList.remove('recording');
    if (voiceRecorder && voiceRecorder.state !== 'inactive') {
        try { voiceRecorder.stop(); } catch { cancelVoiceRecording(); }
    } else {
        stopVoiceTracks(); hideVoiceStatus(); voiceRecorder = null;
    }
}

function cancelVoiceRecording() {
    voiceHold = false; voiceCancel = true; voiceShouldSend = false;
    clearVoiceTimers();
    document.getElementById('voice-btn')?.classList.remove('recording');
    if (voiceRecorder && voiceRecorder.state !== 'inactive') {
        try { voiceRecorder.stop(); } catch {}
    }
    voiceRecorder = null; voiceChunks = [];
    stopVoiceTracks(); hideVoiceStatus();
}

async function completeVoiceRecording() {
    const recorder = voiceRecorder;
    const chunks = voiceChunks.slice();
    const durationMs = Math.min(VOICE_MAX_MS, Date.now() - voiceStartedAt);
    const shouldSend = voiceShouldSend && durationMs >= 500 && currentRoom;
    const mime = (recorder?.mimeType || chunks[0]?.type || 'audio/webm').split(';')[0];
    voiceRecorder = null; voiceChunks = []; voiceShouldSend = false;
    stopVoiceTracks(); clearVoiceTimers();
    if (!shouldSend || !chunks.length) { hideVoiceStatus(); return; }

    const blob = new Blob(chunks, { type: mime });
    if (!blob.size || blob.size > 512 * 1024) { hideVoiceStatus(); alert(L('语音文件过大，请重试', 'Voice clip too large, try again')); return; }
    voiceUploading = true; voiceStatus('正在发送语音…');
    try {
        const res = await fetch('/api/voice', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + localStorage.getItem('token'),
                'Content-Type': mime,
                'X-Room-Id': currentRoom
            },
            body: blob
        });
        if (!res.ok) {
            let msg = '语音发送失败';
            try { msg = (await res.json()).error || msg; } catch {}
            throw new Error(msg);
        }
    } catch (err) {
        alert(err.message || '语音发送失败');
    } finally {
        voiceUploading = false; hideVoiceStatus();
    }
}

function makeVoiceButton(message) {
    const sec = Math.max(1, Math.round((message.durationMs || 0) / 1000));
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = `🎤 ${sec}秒`;
    btn.addEventListener('click', ev => { ev.stopPropagation(); playVoice(message.id, btn); });
    return btn;
}

function showVoiceBubble(message) {
    const now = Date.now();
    const hideAt = Math.min(message?.bubbleUntil || now + VOICE_BUBBLE_MS, now + VOICE_BUBBLE_MS);
    if (!message?.id || hideAt <= now || (message.expiresAt && message.expiresAt <= now)) return;
    removeVoiceBubble(message.id);
    const box = document.createElement('div');
    box.dataset.voiceId = message.id;
    const name = document.createElement('span');
    name.className = 'voice-sender'; name.textContent = message.username || '观众';
    box.append(name, makeVoiceButton(message));
    const entry = { message, box, hideAt, timer: null };
    entry.timer = setTimeout(() => removeVoiceBubble(message.id), hideAt - now);
    activeVoiceBubbles.set(message.id, entry);
    attachVoiceBubble(entry);
}

function voiceSeat(userId) {
    return Array.from(document.querySelectorAll('.seat[data-uid]'))
        .find(el => el.dataset.uid === String(userId));
}

function attachVoiceBubble(entry) {
    if (!entry || entry.hideAt <= Date.now()) {
        if (entry) removeVoiceBubble(entry.message.id);
        return;
    }
    const seat = voiceSeat(entry.message.userId);
    entry.box.className = seat ? 'seat-bubble voice-bubble' : 'voice-float';
    // appendChild 可以把被座位重绘拆下的同一个气泡节点挂回去，不会重新计时。
    (seat || document.body).appendChild(entry.box);
}

function restoreVoiceBubbles() {
    for (const entry of activeVoiceBubbles.values()) attachVoiceBubble(entry);
}

function removeVoiceBubble(id) {
    const entry = activeVoiceBubbles.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.box.remove();
    activeVoiceBubbles.delete(id);
}

function clearVoiceBubbles() {
    for (const id of Array.from(activeVoiceBubbles.keys())) removeVoiceBubble(id);
}

function clearPlayingVoiceAudio() {
    if (!playingVoice) return;
    playingVoice.audio.pause();
    URL.revokeObjectURL(playingVoice.url);
    playingVoice.button?.classList.remove('playing');
    if (playingVoice.button?.dataset.label) playingVoice.button.textContent = playingVoice.button.dataset.label;
    playingVoice = null;
}

function stopVoicePlayback() {
    voicePlayRequestId++;
    if (voicePlayController) voicePlayController.abort();
    voicePlayController = null;
    clearPlayingVoiceAudio();
}

async function playVoice(id, button) {
    if (playingVoice?.id === id) { stopVoicePlayback(); button.textContent = button.dataset.label || button.textContent; return; }
    stopVoicePlayback();
    const requestId = voicePlayRequestId;
    const controller = new AbortController();
    voicePlayController = controller;
    button.dataset.label = button.textContent; button.textContent = '加载中…';
    try {
        const res = await fetch('/api/voice/' + encodeURIComponent(id), {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            signal: controller.signal
        });
        if (!res.ok) throw new Error(res.status === 410 || res.status === 404 ? '语音已过期' : '无法播放语音');
        const blob = await res.blob();
        if (requestId !== voicePlayRequestId || controller.signal.aborted) return;
        // 下载期间可能已有别的音频开始；真正播放前再清理一次。
        clearPlayingVoiceAudio();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        playingVoice = { id, audio, url, button };
        button.textContent = '⏸ 播放中'; button.classList.add('playing');
        const done = () => {
            if (playingVoice?.audio !== audio) return;
            URL.revokeObjectURL(url); button.classList.remove('playing');
            button.textContent = button.dataset.label; playingVoice = null;
        };
        audio.onended = done; audio.onerror = done;
        await audio.play();
    } catch (err) {
        if (err?.name === 'AbortError') {
            button.classList.remove('playing'); button.textContent = button.dataset.label || '🎤';
            return;
        }
        if (playingVoice?.id === id) stopVoicePlayback();
        button.classList.remove('playing'); button.textContent = button.dataset.label || '🎤';
        alert(err.message || '无法播放语音');
    } finally {
        if (voicePlayController === controller) voicePlayController = null;
    }
}

function voiceSupported() {
    // 麦克风录制需「安全环境」(HTTPS 或 localhost)；http 明文(如测试服内网 IP)下 mediaDevices 不可用
    return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}
function setupVoiceRecording() {
    const btn = document.getElementById('voice-btn'); if (!btn) return;
    if (!voiceSupported()) {
        // 不支持：不绑「按住说话」(避免 pointer 捕获卡住 + 反复弹窗)，点一下给一次轻提示即可
        btn.classList.add('disabled');
        btn.title = '语音需在 HTTPS 环境使用';
        btn.addEventListener('click', () => {
            const msg = window.isSecureContext
                ? '当前设备/浏览器不支持语音录制（建议新版 Chrome / Safari）'
                : '语音需在 HTTPS 安全环境使用；当前是明文测试地址，正式版 https://pokerdojo.space 可用';
            toast(msg);
        });
        return;
    }
    btn.addEventListener('pointerdown', beginVoiceRecording);
    btn.addEventListener('pointermove', moveVoiceRecording);
    btn.addEventListener('pointerup', releaseVoiceRecording);
    btn.addEventListener('pointercancel', () => { voiceHold = false; finishVoiceRecording(false); });
    btn.addEventListener('contextmenu', e => e.preventDefault());
}
