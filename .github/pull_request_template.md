## What & why / 改了什么、为什么


## How verified / 如何验证
<!-- `npm test` and `npm run check` run in CI. For game-flow or money changes, say which test covers it.
     CI 会跑 npm test 和 npm run check。改动牌局流程或金币逻辑时，说明哪条测试覆盖了它。 -->


## Checklist
- [ ] `npm test` and `npm run check` pass locally
- [ ] The JS server (`PokerServer/`) is the source of truth; C# left as-is or intentionally updated
- [ ] No secrets or data committed (`data.json`, `secret.key`, `mail.json`, `hands.jsonl`, `*.env`)
- [ ] Commits are signed off (`git commit -s`) per the DCO in CONTRIBUTING.md
- [ ] Matches the surrounding code's style, naming, and comment density
- [ ] Any test accounts I created were cleaned up
