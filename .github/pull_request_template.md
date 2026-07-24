## What & why / 改了什么、为什么


## How verified / 如何验证
<!-- For game-flow changes (betting, side pots, run-it, seating), paste the socket-test result.
     改动游戏流程（下注 / 边池 / 多次发牌 / 座位）请附 socket 测试结果。 -->


## Checklist
- [ ] The JS server (`PokerServer/`) is the source of truth; C# left as-is or intentionally updated
- [ ] No secrets or data committed (`data.json`, `secret.key`, `mail.json`, `hands.jsonl`, `*.env`)
- [ ] Commits are signed off (`git commit -s`) per the DCO in CONTRIBUTING.md
- [ ] Matches the surrounding code's style, naming, and comment density
- [ ] Any test accounts I created were cleaned up
