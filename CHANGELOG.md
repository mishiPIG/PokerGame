# Changelog

All notable changes to Poker Dojo. This project loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are UTC+8.

## [Unreleased]
- AI opponents (trained on per-player hand histories)
- Avatar upload / rename, richer admin tools
- Bankruptcy relief, SQLite/Postgres migration

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

_For detailed development notes, see `CLAUDE.md`._
