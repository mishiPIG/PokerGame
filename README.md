<p align="right"><a href="./README.zh-CN.md">中文</a> | <b>English</b></p>

# 🀄 Poker Dojo (德扑道场)

> Open a private room, play Texas Hold'em with friends, grow together — and let every hand become training data for AI.

Poker Dojo is a **server-authoritative** online Texas Hold'em game built for playing with friends. All game logic (shuffling, dealing, hand evaluation, betting, settlement) runs on the server; clients only render and send actions. It ships with a lobby, SNG tournaments, cash "training" tables, a full multiplayer engine (real side pots, run-it-N-times), hand histories, career stats, chat/emote/voice, and a Capacitor Android shell.

> **Responsible play:** This is a **play-money** game for friends to practice and have fun. It is **not gambling** — no real-money wagering, cash-out, or prizes. Green competition, stay away from gambling.

---

## 📸 Screenshots

<!-- Drop images into docs/screenshots/ and uncomment:
| Lobby | 9-max table | Run it N times |
|---|---|---|
| ![lobby](docs/screenshots/lobby.png) | ![table](docs/screenshots/table.png) | ![run-it](docs/screenshots/run-it.png) |
-->
_Screenshots coming soon — see [`docs/screenshots/`](./docs/screenshots/)._

---

## ✨ Features

- **Server-authoritative engine** — hole cards are private (`io.to(socketId)`), broadcasts carry only public info, every action is validated server-side. You cannot cheat by inspecting your own traffic.
- **Provably fair dealing** — fresh deck every hand, Fisher–Yates, unbiased and unpredictable. Every hand is **committed to before the deal and revealed after**, so anyone can recompute the deck offline and check it was never changed mid-hand ([how to verify](#-provably-fair)).
- **Two room types**
  - **SNG** (Sit-N-Go single-table tournament): increasing blinds, elimination, prize pool with rake.
  - **Cash / "Training" table** (2–9 players): fixed blinds, buy-in/cash-out at a gold↔chips rate, training duration + extensions.
- **Full multiplayer engine** — proper action order (UTG first), button rotation, and **real side pots** (with adjacent-pot merging + uncalled-bet return).
- **Run it N times** — when two players are all-in, the underdog picks how many times to run (1–5) and the leader agrees; the pot is split into N shares, each dealt street-by-street on the table.
- **Hand histories = data asset** — every hand (per-street actions, think time, hole cards, board, result, timestamp) is archived per player and per game mode in SQLite, doubling as **AI training data**. Each hand also keeps its full original record verbatim, so nothing is lost to schema changes.
- **Career stats** — VPIP / PFR / 3-bet / C-bet / AF / WTSD / net + profit curve, aggregated from hand histories.
- **Table UX** — ring seating, avatars, breathing action timer + ring countdown, four-color deck, bet slider, pre-actions, all-in equity %, chip/pot animations, haptics.
- **Social** — in-table chat + quick phrases, tap-avatar emotes, push-to-talk voice bubbles.
- **Accounts & security** — username/email registration with email verification codes, JWT auth (per-server random signing key), TLS/WSS in production.
- **Android** — a thin **Capacitor** shell points at the live site; the game updates by deploying the server, no re-release needed.

---

## 🔒 Provably fair

The shuffle was always unbiased — a fresh deck every hand, Fisher–Yates, seeded from a CSPRNG.
But you had no way to **check** that; you had to take our word for it.
Now every hand is committed to *before* it is dealt and revealed after, so you can verify it yourself, offline.

### How it works

1. **Before any card is dealt**, the server publishes `commit = SHA256(serverSeed)` to the whole table.
2. The entire deck order is derived deterministically from `(serverSeed, clientSeed, nonce)`.
   There is no other source of randomness.
3. **When the whole table ends**, the server publishes `serverSeed` together with the full deck
   order, and you can pull it from your hand history.

   Why the table and not each hand: revealing the seed reveals the *entire* deck — including cards
   other players folded and never showed. Publishing that between hands would hand everyone at the
   table a free HUD. Waiting until the table breaks up costs you nothing: the commitment was already
   public before the deal, so it is just as verifiable later.

Because the commitment is published *before* the deal, the server cannot change the deck after
seeing anyone's cards — a different deck would no longer match the commitment everyone already holds.

### Verify a hand yourself

1. **After the table has ended**, in the app: **Hand history → open a hand → 🔒 Verify data**,
   which copies the full hand record as JSON. Save it as `hand.json`.
   (While a table is still running the seed is withheld, and the button tells you so.)
   (The current hand's commitment is visible any time under **table menu ☰ → 🔒 Fairness**.)
2. Run:

```bash
node PokerServer/tools/verify-hand.js hand.json

# output is Chinese by default; add --en for English
node PokerServer/tools/verify-hand.js hand.json --en
```

It checks three things:

| # | Check | Why it matters |
|---|---|---|
| 1 | `SHA256(revealed seed)` equals the commitment published before the deal | the server was locked in before it saw a single card |
| 2 | Re-shuffling with the revealed seed reproduces the recorded deck order | that order really did come from that seed |
| 3 | That deck order explains the hole cards and board you actually saw | this is the deck that was dealt to **you** |

The verifier never contacts the server and uses nothing but standard SHA-256. The whole scheme is a
few dozen lines (`PokerServer/src/games/poker/provably-fair.js`) — reimplement it in any language
and you should get the same answer.

Want to confirm the checker isn't just rubber-stamping? Edit one card in `community` and run it
again — it fails.

### What this proves, and what it doesn't

- ✅ **It proves** the server cannot alter the deck after seeing any player's cards.
  That is the thing players actually worry about.
- ⚠️ **It does not prove** that the server didn't grind many seeds *before* committing in order to
  pick a favourable one. Defending against that requires the player to choose `clientSeed` **after**
  seeing the commitment. The commitment is already published one hand in advance, so the hook is
  there — but a player-supplied `clientSeed` is not built yet; today it is simply the room number.

> One implementation note, since it is the easiest way to get this wrong: the seeded RNG uses
> **rejection sampling**, not `byte % n`. Plain modulo would bias the deck toward the first few
> cards. At 32 bits that bias is ~1e-8 — far too small for any statistical test to catch, which is
> exactly why it has to be handled structurally rather than "tested for".

---

## 🧱 Architecture

```
Browser / Android (thin client)  ──socket.io──►  Node server (authoritative)
   render + input only                              shuffle · deal · evaluate
                                                     bet · side pots · settle
                                                     hand history (SQLite)
```

- **Server authority:** all rules on the server; clients never receive opponents' hole cards.
- **Hand evaluation:** Cactus Kev + Paul Senzee perfect-hash. Each card is a 32-bit int; 7-card hands enumerate C(7,5); score 1 (best) … 7462 (worst). JS port uses `>>> 0` for unsigned 32-bit math.
- **Storage:** SQLite is the durable source of truth for users, wallet transactions, hand histories, and active-match snapshots. Memory remains the real-time working state; unfinished matches are restored after restart.

### Project structure

| Path | What |
|------|------|
| `PokerServer/` | Node.js game server (Express + Socket.IO) and the single-page client (`index.html`) |
| `PokerLogic/`  | C# reference prototype of the hand evaluator (algorithm origin; JS is authoritative) |
| `mobile/`      | Capacitor Android shell (`capacitor.config.json` points at the live URL) |
| `docs/`        | Design notes |

**Tech:** Node.js · Express · Socket.IO · vanilla HTML/CSS/JS client · JWT · bcrypt · nodemailer · SQLite (better-sqlite3, WAL).

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

Planned: AI opponents (trained on per-player hand histories) · richer admin tools · avatar upload · bankruptcy relief · card-face themes.

See [`CHANGELOG.md`](./CHANGELOG.md) for release history and
[`docs/archive/`](./docs/archive/) for the legacy development notes.

---

## 🤝 Contributing

Issues and PRs are welcome — this project is public so friends can help improve it. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first. The **JS server (`PokerServer/`) is the source of truth**; the C# code is a reference prototype only.

Found a security issue (auth, hole-card leakage, economy exploit)? Please follow [`SECURITY.md`](./SECURITY.md) and report privately.

---

## 📄 License & branding

This project is licensed under the **[PolyForm Noncommercial License 1.0.0](./LICENSE)**. The source is **public and open to contributions**, and you may use, self-host, and modify it **for any noncommercial purpose**. **Any commercial use requires the author's written permission** — please reach out to arrange a commercial license.

The product name **"Poker Dojo / 德扑道场"** and its logo are **not** covered by the code license — please don't use the name or branding for your own product, even if your use of the code is permitted.

© Poker Dojo. All rights reserved except as granted by the LICENSE.
