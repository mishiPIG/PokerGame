# Contributing / 参与贡献

Thanks for helping improve Poker Dojo! 感谢参与改进德扑道场!

## Ground rules / 基本约定

- **The JS server is the source of truth.** All game logic lives in `PokerServer/` (Node + Socket.IO). The C# code in `PokerLogic/` is a reference prototype of the hand evaluator only — you do **not** need to keep it in sync.
  **JS 服务端是权威实现**,游戏逻辑都在 `PokerServer/`;`PokerLogic/` 的 C# 仅作牌力评估算法参考,无需同步。
- **Never commit secrets or data.** SQLite database/WAL/SHM files, legacy `data.json`/`hands.jsonl`, `secret.key`, `mail.json`, and `*.env` are gitignored and must stay out of the repo. Don't paste server IPs, keys, or credentials into code or PRs.
  **不要提交任何密钥或数据**：SQLite 数据库/WAL/SHM、旧版 `data.json`/`hands.jsonl`、`secret.key`、`mail.json`、`*.env` 均不得入库，也不要把服务器 IP、密钥、凭据写进代码或 PR。
- **Socket events use `snake_case`** (e.g. `join_room`, `player_action`). Game state lives in the in-memory `roomGames` object keyed by room id.
- **Match the surrounding code.** Follow the existing style, naming, and comment density of the file you're editing.

## Local setup / 本地开发

```bash
cd PokerServer
npm install
LOCAL_DEV=1 PORT=3000 node server.js   # http://127.0.0.1:3000, seeds test/test & test2/test2
```

## Testing / 测试

```bash
cd PokerServer
npm test          # Node's built-in test runner (node --test), ~350 tests, a few seconds
npm run check     # lint + structural gates (i18n, escaping, CSS, timers, destructuring)
```

Both run in CI on every push and PR (Node 20 and 22). `npm run check` is also the pre-deploy gate, so a failing check blocks deployment.

When you change game flow (betting, side pots, run-it, seating, disconnects) or anything that moves gold or chips, add a test that drives the real engine (see `short-blind.test.js` and `table-flow.test.js` for the pattern) and, for socket-level behaviour, a short socket.io-client script against a local server.

两条命令都会在 CI 上跑（Node 20 / 22），`npm run check` 也是部署前的关卡。
改动牌局流程（下注、边池、多次发牌、座位、掉线）或任何动金币 / 筹码的逻辑时，请加一个用真实引擎跑的测试
（写法参考 `short-blind.test.js`、`table-flow.test.js`），必要时再附一段连本地服务器的 socket 脚本结果。

Text shown to players must be bilingual from the start (`L('中文', 'English')` or a `t()` key); user-supplied text must go through `escapeHtml` before it reaches HTML. Both are enforced by `npm run check`.

Test accounts should share a known password so they can be cleaned up afterward. Delete any test accounts you create.

## Pull requests / 提交 PR

- Keep PRs focused; describe **what** changed and **why**, and how you verified it.
- Sign your commits with **DCO** so authorship/relicensing rights are clear:
  ```bash
  git commit -s -m "your message"   # adds: Signed-off-by: Your Name <you@example.com>
  ```
  By signing off you certify the [Developer Certificate of Origin](https://developercertificate.org/) and agree your contribution is licensed under this project's LICENSE.
- By contributing, you grant the project maintainer the rights needed to license and, if applicable, relicense the project (including offering separate commercial licenses).
  贡献即表示你授予维护者对本项目进行许可(含必要时的重新许可/单独商业授权)所需的权利。

## Reporting bugs / 报告 Bug

Use GitHub Issues for regular bugs. For **security** issues, follow [`SECURITY.md`](./SECURITY.md) and report privately.
