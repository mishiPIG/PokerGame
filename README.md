<p align="right"><a href="./README.zh-CN.md">中文</a> | <b>English</b></p>

# 🀄 Poker Dojo (德扑道场)

> Open a private room, play Texas Hold'em with friends, grow together — and let every hand become training data for AI.

Poker Dojo is a **server-authoritative** online Texas Hold'em game built for playing with friends. All game logic (shuffling, dealing, hand evaluation, betting, settlement) runs on the server; clients only render and send actions. It ships with a lobby, SNG tournaments, cash "training" tables, a full multiplayer engine (real side pots, run-it-N-times), hand histories, career stats, chat/emote/voice, and a Capacitor Android shell.

> **Responsible play:** This is a **play-money** game for friends to practice and have fun. It is **not gambling** — no real-money wagering, cash-out, or prizes. Green competition, stay away from gambling.

---

## ✨ Features

- **Server-authoritative engine** — hole cards are private (`io.to(socketId)`), broadcasts carry only public info, every action is validated server-side. You cannot cheat by inspecting your own traffic.
- **Provably fair shuffle** — fresh deck every hand, Fisher–Yates with a **CSPRNG** (`crypto.randomInt`), unbiased and unpredictable. A Monte-Carlo self-check matches theoretical hand-type frequencies.
- **Two room types**
  - **SNG** (Sit-N-Go single-table tournament): increasing blinds, elimination, prize pool with rake.
  - **Cash / "Training" table** (2–9 players): fixed blinds, buy-in/cash-out at a gold↔chips rate, training duration + extensions.
- **Full multiplayer engine** — proper action order (UTG first), button rotation, and **real side pots** (with adjacent-pot merging + uncalled-bet return).
- **Run it N times** — when two players are all-in, the underdog picks how many times to run (1–5) and the leader agrees; the pot is split into N shares, each dealt street-by-street on the table.
- **Hand histories = data asset** — every hand (per-street actions, think time, hole cards, board, result, timestamp) is archived per player and per game mode as append-only JSONL, doubling as **AI training data**.
- **Career stats** — VPIP / PFR / 3-bet / C-bet / AF / WTSD / net + profit curve, aggregated from hand histories.
- **Table UX** — ring seating, avatars, breathing action timer + ring countdown, four-color deck, bet slider, pre-actions, all-in equity %, chip/pot animations, haptics.
- **Social** — in-table chat + quick phrases, tap-avatar emotes, push-to-talk voice bubbles.
- **Accounts & security** — username/email registration with email verification codes, JWT auth (per-server random signing key), TLS/WSS in production.
- **Android** — a thin **Capacitor** shell points at the live site; the game updates by deploying the server, no re-release needed.

---

## 🧱 Architecture

```
Browser / Android (thin client)  ──socket.io──►  Node server (authoritative)
   render + input only                              shuffle · deal · evaluate
                                                     bet · side pots · settle
                                                     hand history (JSONL)
```

- **Server authority:** all rules on the server; clients never receive opponents' hole cards.
- **Hand evaluation:** Cactus Kev + Paul Senzee perfect-hash. Each card is a 32-bit int; 7-card hands enumerate C(7,5); score 1 (best) … 7462 (worst). JS port uses `>>> 0` for unsigned 32-bit math.
- **Storage:** in-memory game state + JSON files (`data.json` users, `hands.jsonl` hand history). The `database.js` interface is stable so it can move to SQLite/Postgres later without touching callers.

### Project structure

| Path | What |
|------|------|
| `PokerServer/` | Node.js game server (Express + Socket.IO) and the single-page client (`index.html`) |
| `PokerLogic/`  | C# reference prototype of the hand evaluator (algorithm origin; JS is authoritative) |
| `mobile/`      | Capacitor Android shell (`capacitor.config.json` points at the live URL) |
| `docs/`        | Design notes |

**Tech:** Node.js · Express · Socket.IO · vanilla HTML/CSS/JS client · JWT · bcrypt · nodemailer · JSON-file storage.

---

## 🚀 Quick start (local dev)

```bash
cd PokerServer
npm install
LOCAL_DEV=1 PORT=3000 node server.js
# open http://127.0.0.1:3000
```

`LOCAL_DEV=1` binds to localhost and seeds two throwaway accounts (`test`/`test`, `test2`/`test2`) so you can log in immediately. Email sending falls back to printing verification codes to the server log when SMTP isn't configured.

> Production deployment (server provisioning, TLS, backups) is intentionally kept out of this README.

---

## 🗺️ Roadmap highlights

Done: multiplayer engine + real side pots · SNG & cash tables · run-it-N-times · hand histories + replay · career stats · avatars/chat/emote/voice · CSPRNG shuffle · email accounts + TLS · Android build.

Planned: AI opponents (trained on per-player hand histories) · richer admin tools · avatar upload/rename · bankruptcy relief · SQLite/Postgres migration.

See `CLAUDE.md` for detailed development notes and history.

---

## 🤝 Contributing

Issues and PRs are welcome — this project is public so friends can help improve it. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first. The **JS server (`PokerServer/`) is the source of truth**; the C# code is a reference prototype only.

Found a security issue (auth, hole-card leakage, economy exploit)? Please follow [`SECURITY.md`](./SECURITY.md) and report privately.

---

## 📄 License & branding

This project is licensed under the **[PolyForm Noncommercial License 1.0.0](./LICENSE)**. The source is **public and open to contributions**, and you may use, self-host, and modify it **for any noncommercial purpose**. **Any commercial use requires the author's written permission** — please reach out to arrange a commercial license.

The product name **"Poker Dojo / 德扑道场"** and its logo are **not** covered by the code license — please don't use the name or branding for your own product, even if your use of the code is permitted.

© Poker Dojo. All rights reserved except as granted by the LICENSE.
