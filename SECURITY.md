# Security Policy / 安全策略

## Reporting a vulnerability / 报告安全漏洞

Because this is an online game with accounts, a virtual economy, and hidden information (hole cards), **please report security issues privately — do not open a public issue.**

因为这是一款带账号、虚拟经济和隐藏信息(底牌)的在线游戏,**请私下报告安全问题,不要公开提 Issue。**

**Preferred channel / 首选方式:** GitHub → this repo → **Security** tab → **Report a vulnerability** (private security advisory).

We especially care about:

- 认证 / authentication & session (JWT, login, password reset)
- 底牌 / hidden-information leakage (any way to learn opponents' hole cards)
- 经济 / economy exploits (gold/chips duplication, unauthorized balance changes)
- 越权 / action authorization (acting out of turn, illegal bets, admin bypass)

Please include reproduction steps and, if possible, the affected commit. We'll acknowledge as soon as we can. Please give us reasonable time to fix before any public disclosure.

请附上复现步骤(如可能附上受影响的 commit)。我们会尽快回复;在修复前请给予合理的披露缓冲时间。

## Out of scope / 不在范围

- Collusion between real players (a human-factor problem, not a software bug).
- Issues that require a compromised device / physical access to the victim's machine.
