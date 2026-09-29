// 发信：nodemailer + SMTP。配置优先环境变量，其次本地 mail.json（不进 git、部署不覆盖）。
// 未配置时进入「开发回退」：把验证码打到服务器日志，方便先联调。
//
// 🔴 两个通道（2026-09-29）：
//   · 验证码 → mail.json 的 `codes` 块（事务邮件服务，额度大）；没配 `codes` 就退回主通道
//   · 反馈 / 系统告警 → 主通道（发给管理员自己，量很小）
// 为什么要分开：原来全站共用一个免费 163（每天 50 封）。验证码一旦把额度烧光，
// 【同一天的备份/审计/崩溃告警也一起发不出去】—— 最需要喊出来的时候恰好哑了。
//
// mail.json 形如：
//   { "host": "smtp.163.com", "port": 465, "user": "…", "pass": "…", "alertTo": "…",
//     "codes": { "host": "…", "port": 465, "user": "…", "pass": "…", "from": "德扑道场 <noreply@pokerdojo.space>" } }
const path = require('path');
const fs = require('fs');

const HOUR = 60 * 60 * 1000;

function readDefaultConfig() {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        return {
            host: process.env.SMTP_HOST || 'smtp.qq.com',
            port: +(process.env.SMTP_PORT || 465),
            user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
            from: process.env.SMTP_FROM || `德扑道场 <${process.env.SMTP_USER}>`
        };
    }
    const p = path.join(__dirname, 'mail.json');
    if (fs.existsSync(p)) {
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { console.error('mail.json 解析失败', e.message); }
    }
    return null;
}

function createMailer({ readConfig = readDefaultConfig, createTransport = null, now = () => Date.now(), log = console } = {}) {
    let cfg;
    const transports = {};
    let lastCodeFailAlertAt = null;   // null = 从没报过。别用 0：那等于「在 1970 年报过一次」

    const config = () => {
        if (cfg === undefined) cfg = readConfig() || null;
        return cfg;
    };

    // name: 'main' | 'codes'。codes 块不完整时退回主通道（并提示一次），而不是让验证码直接发不出去。
    let warnedIncompleteCodes = false;
    function channel(name) {
        const c = config();
        if (!c || !createTransport) return null;
        let sub = c, key = 'main';
        if (name === 'codes' && c.codes) {
            if (c.codes.user && c.codes.pass) { sub = c.codes; key = 'codes'; }
            else if (!warnedIncompleteCodes) {
                warnedIncompleteCodes = true;
                log.error('[mail] mail.json 的 codes 块缺 user/pass，验证码退回主通道发送');
            }
        }
        if (!sub.user || !sub.pass) return null;
        if (!transports[key]) {
            const port = sub.port || 465;
            transports[key] = createTransport({
                host: sub.host || 'smtp.qq.com', port, secure: port === 465,
                auth: { user: sub.user, pass: sub.pass },
            });
        }
        return { t: transports[key], from: sub.from || `德扑道场 <${sub.user}>`, separate: key === 'codes', cfg: c };
    }

    const isConfigured = () => !!channel('codes');

    // 验证码邮件中英双语：海外玩家收到一封纯中文邮件，连哪串是验证码都认不出。
    async function sendCode(to, code, purpose) {
        const zh = purpose === 'reset' ? '重置密码验证码' : purpose === 'bind' ? '绑定邮箱验证码' : '注册验证码';
        const en = purpose === 'reset' ? 'password reset code' : purpose === 'bind' ? 'email verification code' : 'sign-up code';
        const subject = `德扑道场 Poker Dojo · ${zh} / ${en}`;
        const text = `【德扑道场 Poker Dojo】\n`
            + `你的验证码是：${code}\n10 分钟内有效，请勿泄露。若非本人操作请忽略本邮件。\n\n`
            + `Your ${en} is: ${code}\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.`;
        const ch = channel('codes');
        if (!ch) { log.log(`\n[mail:DEV] 未配置发信服务，验证码 → ${to} : ${code}  (${purpose})\n`); return { dev: true }; }
        try {
            await ch.t.sendMail({ from: ch.from, to, subject, text });
            return { sent: true };
        } catch (e) {
            noteCodeFailure(e, ch.separate);
            throw e;   // 调用方（注册接口）要靠它给玩家回「发送失败」
        }
    }

    // 🔴 验证码发不出去 = 当天没人能注册/找回密码。原来只写 pm2 错误日志，没人看。
    //    现在走主通道喊一声；每小时最多一封，防止一次额度耗尽刷出几十封告警。
    function noteCodeFailure(err, separate) {
        const t = now();
        if (lastCodeFailAlertAt !== null && t - lastCodeFailAlertAt < HOUR) return;
        lastCodeFailAlertAt = t;
        const detail = [err && err.responseCode, err && err.message].filter(Boolean).join(' · ');
        const body = `验证码邮件发送失败：${detail || '（无错误信息）'}\n\n`
            + '影响：失败期间新玩家无法注册、老玩家无法找回密码/绑定邮箱。\n'
            + '常见原因：发信额度用完（免费 163 每天 50 封）、授权码失效、发信服务故障。\n'
            + (separate ? '' : '⚠️ 验证码与告警目前共用同一个发信通道 —— 如果是额度用完，这封告警本身也可能发不出来。\n')
            + '（一小时内的后续失败不再重复告警，详见 pm2 错误日志。）';
        sendAlert('验证码发送失败', body).catch(e2 => {
            log.error('[mail] 验证码失败告警也没发出去', e2 && e2.message);
        });
    }

    // 前端构建号不在服务端版本串里 = 玩家用的是缓存的旧前端。
    // 很多「我这边复现不了」的反馈都是这个原因，标出来能省一轮来回。
    function staleClient(r) {
        const c = r.clientBuild, s = r.serverVersion;
        if (!c || !s || c === 'unknown' || c === 'dev') return false;
        return !s.includes(c);
    }

    // 用户 Bug/建议反馈 → 发一封到管理员邮箱（默认发给发信账号本身，可用 mail.json.feedbackTo 覆盖）
    async function sendFeedback(record) {
        const subject = `德扑道场 · 用户反馈 · ${record.username}`;
        const body = `用户：${record.username} (${record.userId})\n`
            + `时间：${new Date(record.ts).toLocaleString('zh-CN', { hour12: false })}\n`
            + `联系方式：${record.contact || '（未填）'}\n`
            + `设备：${record.ua || ''}\n`
            // 版本自动带上：收到反馈就知道是哪一版，不用再回头问玩家「你是什么时候刷新的」
            + `版本：服务端 ${record.serverVersion || '?'} ／ 前端 ${record.clientBuild || '?'}`
            + (staleClient(record) ? '  ⚠️ 前端是缓存的旧版，先让他刷新再排查' : '')
            + `\n\n内容：\n${record.text}`;
        const ch = channel('main');
        if (!ch) { log.log(`\n[mail:DEV] 用户反馈（未配置发信）↓\n${body}\n`); return { dev: true }; }
        const to = ch.cfg.feedbackTo || ch.cfg.user;
        await ch.t.sendMail({ from: ch.from, to, subject, text: body });
        return { sent: true };
    }

    // 系统告警 → 发到管理员邮箱（如筹码守恒审计发现异常）。未配置发信则打印到日志。
    async function sendAlert(subject, body) {
        const ch = channel('main');
        if (!ch) { log.log(`\n[mail:DEV] 系统告警（未配置发信）↓\n${subject}\n${body}\n`); return { dev: true }; }
        const to = ch.cfg.alertTo || ch.cfg.feedbackTo || ch.cfg.user;
        await ch.t.sendMail({ from: ch.from, to, subject: `德扑道场 · ${subject}`, text: body });
        return { sent: true };
    }

    return { sendCode, sendFeedback, sendAlert, isConfigured };
}

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* 未安装时走 dev 回退 */ }

const defaultMailer = createMailer({
    createTransport: nodemailer ? (opts) => nodemailer.createTransport(opts) : null,
});

module.exports = { ...defaultMailer, createMailer };
