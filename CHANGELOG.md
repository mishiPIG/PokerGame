# Changelog

All notable changes to Poker Dojo. This project loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are UTC+8.

## [Unreleased]
- AI opponents (trained on per-player hand histories)
- Avatar upload, richer admin tools
- Bankruptcy relief; card-face themes (the current "deck style" toggle is a no-op — four-color is always on)
- Graceful shutdown (broadcast, finish the current hand, settle, then exit)

### Changed
- Cash training tables no longer settle and dissolve automatically when their scheduled time expires.
  They finish the current hand, pause dealing, and wait for the host to extend or shorten the schedule,
  end the match, or leave it paused.

## 2026-08-08 — SQLite persistence + crash recovery
### Changed
- **Storage moved from JSON files to SQLite** (`better-sqlite3`, WAL). Users, gold, wallet
  transactions, hand histories, feedback and **active-match snapshots** now live in one database
  outside the code directory (`POKER_DB_PATH`). Legacy `data.json` / `hands.jsonl` /
  `feedback.jsonl` are imported automatically on the first deploy and then kept read-only as a
  rollback path. Migration verified against real production data: users, gold totals, messages,
  feedback and all 10,090 hands matched **byte-for-byte**, and the reverse export (SQLite → legacy
  JSON) round-trips losslessly.
- Deploy scripts now stop the process, snapshot the database (SQLite Online Backup), run schema
  migrations, verify integrity/foreign keys, and only then restart — aborting on any failure
  rather than starting with uncertain data.
### Added
- **Crash/restart recovery** — an in-progress hand survives a restart: seats, chips, pot, board and
  action position are restored and players simply reconnect.
- **Wallet ledger** — every gold change is recorded (amount, type, related match, idempotency key),
  making balances auditable after the fact.
- **Chip-conservation audit** (`tools/audit-chips.js`) — poker is zero-sum, so within a hand the sum
  of ending stacks must equal the sum of starting stacks; any mismatch means chips appeared or
  vanished. Runs on demand, from the admin panel, or nightly with email alerts. It found the one
  real defect below among 10,090 hands.
- **Admin panel** — room overview, per-player wallet ledger, hand-history lookup, in-browser audit,
  compensation/deduction with a mandatory note (idempotent, fully logged), and inbox broadcasts.
- **Settlement podium** — playful per-match titles (biggest loser / biggest winner / most hands) plus
  a much more detailed inbox summary.
- **Portrait/landscape switch** — desktop browsers can use the full window instead of a phone-width
  column; card faces scale with height.
- New avatar set (27 poker/dojo icons); editable display names; four-digit room codes that submit
  automatically.
### Fixed
- **All-in players losing their claim to the pot** — leaving, standing up or being moved to the
  spectator seat mid-hand marked an all-in player as folded, which also made the uncalled-bet
  return misfire and created chips out of thin air (one live incident: 16,508 chips). All-in players
  can no longer be folded, and after the all-in reveal nobody holds the action.
- Run-it negotiation window was too tight (25s → 45s, with a fresh window for the leader and a
  visible countdown), which had silently degraded agreed multi-run hands into winner-take-all.
- Incomplete raises no longer reopen the betting round; players who already acted can only call or fold.
- Busted SNG players stay as spectators instead of being kicked to the lobby.
- Dissolving a room now waits for the current hand to finish.
- Seat layout: every player (name, stack, badges) is guaranteed on-screen for 2–9 players across
  portrait/landscape and a range of screen sizes, verified by an automated geometry test.

## 2026-07-24
### Added
- **Run it N times** — two-player all-in negotiation (underdog picks 1–5, leader agrees); pot split into N shares, dealt street-by-street on the table with per-run pot-to-winner animation; hand history records every runout.
- **Host controls** — pause/resume dealing (holds after the current hand), and force a player to the spectator seat.
- Public docs: bilingual README, LICENSE (PolyForm Noncommercial 1.0.0), CONTRIBUTING, SECURITY.
### Fixed
- **Side pots** — merge adjacent pots with identical eligibility and return uncalled bets, removing spurious "side pot 1/2/3…" and fixing run-it settlement with unequal stacks.
- **Action flow** — hand freeze when everyone is all-in from the blinds; a folded player standing up mid-hand stalling the table; already-called players being asked to act again; uncalled all-in players wrongly timed out.
- 9-max seat layout overlap; avatar-popup net now matches the stats panel.

## 2026-07 (earlier)
### Added
- Domain `pokerdojo.space` + TLS/HTTPS/WSS (Caddy); email accounts (verification codes, password reset); daily check-in, feedback inbox, data backups.
- Android build via Capacitor (GitHub Actions, thin shell pointing at the live site).
- Career stats (VPIP/PFR/3-bet/C-bet/AF/WTSD/net + curve); in-table chat, emotes, push-to-talk voice; hand-history replay UI.
- Anti-grief: lobby list = spectate-only, playing requires an invite link / room code.

## 2026-06
### Added
- **Multiplayer engine** (3–9 players): real action order, button rotation, true side pots; cash "training" tables and SNG tournaments; hand histories (JSONL).
- Server-authoritative rewrite hardening: **CSPRNG shuffle** (crypto, unbiased, unpredictable); **JWT signing key** per-server (no public default).
- Lobby + room creation/join, reconnect, invite codes.

## Earlier
- C# hand-evaluator prototype (Cactus Kev + Senzee perfect hash) → JS port.
- Socket.IO multi-room heads-up engine, staged betting, user accounts (JWT, gold economy), table UX v1–v2, production deployment.

_For legacy development notes, see [`docs/archive/`](./docs/archive/)._
