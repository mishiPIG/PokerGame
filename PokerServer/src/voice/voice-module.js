'use strict';

function registerVoiceModule({ app, io, db, roomGames, requireAuth, express, crypto, fs, path, baseDir }) {
// 语音只用于当前牌桌的短暂互动：不进聊天历史、不备份、不进数据库。
// 服务器重启时直接清空；正常运行时 1 小时过期，定时物理删除。
const VOICE_DIR = path.join(baseDir, 'voice_tmp');
const VOICE_TTL_MS = 60 * 60 * 1000;
const VOICE_SWEEP_MS = 5 * 60 * 1000;
const VOICE_BUBBLE_MS = 10000;
const VOICE_MAX_DURATION_MS = 15000;
const VOICE_MAX_BYTES = 512 * 1024;
const VOICE_DIR_MAX_BYTES = 200 * 1024 * 1024;
const VOICE_MAX_PER_HOUR = 60;
const VOICE_UPLOAD_GAP_MS = 3000;
const VOICE_MAX_CONCURRENT_UPLOADS = 12;
const VOICE_MAX_PER_USER_UPLOADS = 2;
const VOICE_UPLOAD_TIMEOUT_MS = 10000;
const VOICE_MIMES = new Map([
    ['audio/mp4', 'm4a'], ['audio/aac', 'aac'], ['audio/mpeg', 'mp3'],
    ['audio/webm', 'webm'], ['audio/ogg', 'ogg']
]);
const voiceEntries = new Map();
const voiceRate = new Map();
const voiceUserUploads = new Map();
let voiceBytes = 0;
let voiceUploadsInFlight = 0;
let musicMetadataModule = null;

function resetVoiceTempDir() {
    try {
        fs.rmSync(VOICE_DIR, { recursive: true, force: true });
        fs.mkdirSync(VOICE_DIR, { recursive: true, mode: 0o700 });
    } catch (e) {
        console.error('⚠️ 无法初始化临时语音目录：', e.message);
    }
}

function removeVoiceEntry(id) {
    const entry = voiceEntries.get(id);
    if (!entry) return;
    voiceEntries.delete(id);
    voiceBytes = Math.max(0, voiceBytes - entry.size);
    try { fs.unlinkSync(entry.file); } catch (e) { if (e.code !== 'ENOENT') console.warn('[voice] 删除失败：', e.message); }
}

function sweepExpiredVoices(now = Date.now()) {
    for (const [id, entry] of voiceEntries) {
        if (entry.expiresAt <= now) removeVoiceEntry(id);
    }
}

function userIsConnectedToRoom(userId, roomId) {
    const members = io.sockets.adapter.rooms.get(roomId);
    if (!members) return false;
    for (const sid of members) {
        const s = io.sockets.sockets.get(sid);
        if (s?.user?.id === userId && s.currentRoom === roomId) return true;
    }
    return false;
}

function voicePublicMessage(entry) {
    return {
        id: entry.id, userId: entry.userId, displayName: entry.displayName || entry.username,
        durationMs: entry.durationMs, expiresAt: entry.expiresAt,
        bubbleUntil: entry.bubbleUntil
    };
}

function syncRecentVoices(socket, roomId) {
    const now = Date.now();
    for (const entry of voiceEntries.values()) {
        if (entry.roomId === roomId && entry.bubbleUntil > now)
            socket.emit('voice_broadcast', voicePublicMessage(entry));
    }
}

function allowVoiceUpload(userId, now = Date.now()) {
    let rate = voiceRate.get(userId);
    if (!rate || now - rate.windowStart >= 60 * 60 * 1000) {
        rate = { windowStart: now, count: 0, lastAt: 0 };
    }
    if (now - rate.lastAt < VOICE_UPLOAD_GAP_MS || rate.count >= VOICE_MAX_PER_HOUR) return false;
    rate.lastAt = now;
    rate.count++;
    voiceRate.set(userId, rate);
    return true;
}

async function actualVoiceDurationMs(buffer, mime) {
    musicMetadataModule ||= await import('music-metadata');
    const metadata = await musicMetadataModule.parseBuffer(
        buffer,
        { mimeType: mime, size: buffer.length },
        { duration: true, skipCovers: true }
    );
    const seconds = metadata?.format?.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('NO_DURATION');
    return Math.round(seconds * 1000);
}

function voiceUploadGate(req, res, next) {
    const contentLength = Number(req.headers['content-length']);
    if (!Number.isInteger(contentLength) || contentLength <= 0)
        return res.status(411).json({ error: '语音上传必须声明文件大小' });
    if (contentLength > VOICE_MAX_BYTES)
        return res.status(413).json({ error: '语音文件过大' });
    if (voiceUploadsInFlight >= VOICE_MAX_CONCURRENT_UPLOADS)
        return res.status(503).json({ error: '当前语音上传较多，请稍后再试' });
    const userId = req.authUser.id;
    const userCount = voiceUserUploads.get(userId) || 0;
    if (userCount >= VOICE_MAX_PER_USER_UPLOADS)
        return res.status(429).json({ error: '同一账号最多同时上传 2 条语音' });
    voiceUploadsInFlight++;
    voiceUserUploads.set(userId, userCount + 1);
    let released = false;
    const timeout = setTimeout(() => {
        if (!released) req.destroy();       // 绝对时限，慢速持续传输也不能续期
    }, VOICE_UPLOAD_TIMEOUT_MS);
    timeout.unref?.();
    const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timeout);
        voiceUploadsInFlight--;
        const left = (voiceUserUploads.get(userId) || 1) - 1;
        if (left > 0) voiceUserUploads.set(userId, left); else voiceUserUploads.delete(userId);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
}

resetVoiceTempDir();
const voiceSweepTimer = setInterval(() => sweepExpiredVoices(), VOICE_SWEEP_MS);
voiceSweepTimer.unref?.();

app.post('/api/voice', requireAuth, voiceUploadGate,
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: VOICE_MAX_BYTES }),
    async (req, res) => {
        const roomId = String(req.headers['x-room-id'] || '');
        const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!roomGames[roomId] || !userIsConnectedToRoom(req.authUser.id, roomId))
            return res.status(403).json({ error: '你已不在该房间' });
        if (!VOICE_MIMES.has(mime)) return res.status(415).json({ error: '不支持的录音格式' });
        if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > VOICE_MAX_BYTES)
            return res.status(400).json({ error: '语音文件为空或过大' });
        let durationMs;
        try { durationMs = await actualVoiceDurationMs(req.body, mime); }
        catch { return res.status(422).json({ error: '无法解析语音真实时长' }); }
        if (durationMs < 300 || durationMs > VOICE_MAX_DURATION_MS)
            return res.status(400).json({ error: '语音时长必须在 0.3～15 秒之间' });
        if (!allowVoiceUpload(req.authUser.id))
            return res.status(429).json({ error: '发送太频繁，请稍后再试' });

        sweepExpiredVoices();
        if (voiceBytes + req.body.length > VOICE_DIR_MAX_BYTES)
            return res.status(507).json({ error: '临时语音空间已满，请稍后再试' });

        const id = crypto.randomBytes(16).toString('hex');
        const file = path.join(VOICE_DIR, `${id}.${VOICE_MIMES.get(mime)}`);
        const now = Date.now();
        try {
            fs.writeFileSync(file, req.body, { mode: 0o600, flag: 'wx' });
        } catch (e) {
            console.error('[voice] 写入失败：', e.message);
            return res.status(500).json({ error: '语音保存失败' });
        }
        const entry = {
            id, roomId, userId: req.authUser.id, username: req.authUser.username, displayName: req.authUser.displayName || req.authUser.username,
            file, mime, size: req.body.length, durationMs,
            createdAt: now, expiresAt: now + VOICE_TTL_MS,
            bubbleUntil: now + VOICE_BUBBLE_MS
        };
        voiceEntries.set(id, entry);
        voiceBytes += entry.size;
        io.in(roomId).emit('voice_broadcast', voicePublicMessage(entry));
        res.status(201).json({ ok: true, id, expiresAt: entry.expiresAt });
    }
);

app.get('/api/voice/:id', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).json({ error: '语音不存在' });
    const entry = voiceEntries.get(id);
    if (!entry) return res.status(404).json({ error: '语音已失效' });
    if (entry.expiresAt <= Date.now()) {
        removeVoiceEntry(id);
        return res.status(410).json({ error: '语音已过期' });
    }
    if (!userIsConnectedToRoom(req.authUser.id, entry.roomId))
        return res.status(403).json({ error: '仅当前房间成员可播放' });
    res.set('Cache-Control', 'private, no-store');
    res.type(entry.mime);
    res.sendFile(entry.file);
});


    return { syncRecentVoices };
}

module.exports = { registerVoiceModule };
