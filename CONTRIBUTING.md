# Contributing / 参与贡献

Thanks for helping improve Poker Dojo! 感谢参与改进德扑道场!

## Ground rules / 基本约定

- **The JS server is the source of truth.** All game logic lives in `PokerServer/` (Node + Socket.IO). The C# code in `PokerLogic/` is a reference prototype of the hand evaluator only — you do **not** need to keep it in sync.
  **JS 服务端是权威实现**,游戏逻辑都在 `PokerServer/`;`PokerLogic/` 的 C# 仅作牌力评估算法参考,无需同步。
- **Never commit secrets or data.** `data.json` (users), `hands.jsonl` (hand histories), `secret.key`, `mail.json`, and `*.env` are gitignored and must stay out of the repo. Don't paste server IPs, keys, or credentials into code or PRs.
  **不要提交任何密钥或数据**:`data.json`、`hands.jsonl`、`secret.key`、`mail.json`、`*.env` 均已 gitignore,务必不要入库;也不要把服务器 IP、密钥、凭据写进代码或 PR。
- **Socket events use `snake_case`** (e.g. `join_room`, `player_action`). Game state lives in the in-memory `roomGames` object keyed by room id.
- **Match the surrounding code.** Follow the existing style, naming, and comment density of the file you're editing.

## Local setup / 本地开发

```bash
cd PokerServer
npm install
LOCAL_DEV=1 PORT=3000 node server.js   # http://127.0.0.1:3000, seeds test/test & test2/test2
```

## Testing / 测试

There's no framework; behavior is verified with small **socket.io-client** scripts that log in over `/api/login`, drive a hand, and assert on the broadcasts. When you change game flow (betting, side pots, run-it, seating), add or run such a script and paste the result in your PR.

没有测试框架;用小的 **socket.io-client** 脚本验证行为(登录→驱动一手→断言广播)。改动游戏流程(下注、边池、多次发牌、座位)时,请附上此类脚本的运行结果。

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
