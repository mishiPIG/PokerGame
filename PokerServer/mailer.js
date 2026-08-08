// 发信（验证码）：nodemailer + SMTP。配置优先环境变量，其次本地 mail.json（不进 git）
// 未配置时进入「开发回退」：把验证码打到服务器日志，方便先联调。
const path = require('path');
const fs = require('fs');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* 未安装时走 dev 回退 */ }

let cfg = null, transporter = null;
function loadConfig() {
    if (cfg) return cfg;
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        cfg = {
            host: process.env.SMTP_HOST || 'smtp.qq.com',
            port: +(process.env.SMTP_PORT || 465),
            user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
            from: process.env.SMTP_FROM || `德扑道场 <${process.env.SMTP_USER}>`
        };
        return cfg;
    }
    const p = path.join(__dirname, 'mail.json');
    if (fs.existsSync(p)) { try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('mail.json 解析失败', e.message); } }
    return cfg;
}
function getTransport() {
    if (transporter) return transporter;
    const c = loadConfig();
    if (!c || !c.user || !c.pass || !nodemailer) return null;
    const port = c.port || 465;
    transporter = nodemailer.createTransport({ host: c.host || 'smtp.qq.com', port, secure: port === 465, auth: { user: c.user, pass: c.pass } });
    return transporter;
}
function isConfigured() { return !!getTransport(); }

async function sendCode(to, code, purpose) {
    const subject = purpose === 'reset' ? '德扑道场 · 重置密码验证码'
                  : purpose === 'bind' ? '德扑道场 · 绑定邮箱验证码'
                  : '德扑道场 · 注册验证码';
    const text = `【德扑道场 Poker Dojo】\n你的验证码是：${code}\n10 分钟内有效，请勿泄露。若非本人操作请忽略本邮件。`;
    const t = getTransport();
    if (!t) { console.log(`\n[mail:DEV] 未配置发信服务，验证码 → ${to} : ${code}  (${purpose})\n`); return { dev: true }; }
    const c = loadConfig();
    await t.sendMail({ from: c.from || `德扑道场 <${c.user}>`, to, subject, text });
    return { sent: true };
}
// 用户 Bug/建议反馈 → 发一封到管理员邮箱（默认发给发信账号本身，可用 mail.json.feedbackTo 覆盖）
async function sendFeedback(record) {
    const subject = `德扑道场 · 用户反馈 · ${record.username}`;
    const body = `用户：${record.username} (${record.userId})\n`
        + `时间：${new Date(record.ts).toLocaleString('zh-CN', { hour12: false })}\n`
        + `联系方式：${record.contact || '（未填）'}\n`
        + `设备：${record.ua || ''}\n\n内容：\n${record.text}`;
    const t = getTransport();
    if (!t) { console.log(`\n[mail:DEV] 用户反馈（未配置发信）↓\n${body}\n`); return { dev: true }; }
    const c = loadConfig();
    const to = c.feedbackTo || c.user;
    await t.sendMail({ from: c.from || `德扑道场 <${c.user}>`, to, subject, text: body });
    return { sent: true };
}

// 系统告警 → 发到管理员邮箱（如筹码守恒审计发现异常）。未配置发信则打印到日志。
async function sendAlert(subject, body) {
    const t = getTransport();
    if (!t) { console.log(`\n[mail:DEV] 系统告警（未配置发信）↓\n${subject}\n${body}\n`); return { dev: true }; }
    const c = loadConfig();
    const to = c.alertTo || c.feedbackTo || c.user;
    await t.sendMail({ from: c.from || `德扑道场 <${c.user}>`, to, subject: `德扑道场 · ${subject}`, text: body });
    return { sent: true };
}

module.exports = { sendCode, sendFeedback, sendAlert, isConfigured };
