# Limecore Nexus OS

A three-app personal life-OS suite by [Limecore](https://github.com/Limecore-Studio). Independent
apps that share one Supabase backend, so data flows between them without leaving
your account.

You sign in once. Workouts logged in **Limelog**, courses and study sessions logged
in **StudyDesk**, finances and tasks logged anywhere — they all land in the same
database. **Nexus Command Center** is the cross-domain hub that reads from
everything and surfaces what matters.

---

## The Suite

| App | Role | Status | Repo |
|---|---|---|---|
| **Nexus Command Center** | Cross-domain dashboard. Aggregates the other apps, runs Weekly + Year Reviews, owns Goals, hosts Finance and Tasks. | Active | _This repo_ |
| **StudyDesk** | Focused study companion. Course / grade tracking, study-time timer, reading library. | Active | [Limecore-Studio/StudyDesk](https://github.com/Limecore-Studio/StudyDesk) |
| **Limelog** | Workout & fitness logger. Sessions, sets, reps, RPE; live-pushes into the shared backend. | Active | [Limecore-Studio/limelog](https://github.com/Limecore-Studio/limelog) |

---

## How the apps connect

```
  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
  │  Limelog    │      │  StudyDesk  │      │   (future   │
  │  (workouts) │      │  (study)    │      │    apps)    │
  └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
         │                    │                    │
         │   writes           │   writes           │   writes
         └──────────┬─────────┴──────────┬─────────┘
                    ▼                    ▼
              ┌─────────────────────────────────┐
              │       Supabase (Postgres        │
              │       + RLS + Realtime)         │
              │     One project, one user.      │
              └─────────────────────────────────┘
                              ▲
                              │   reads + writes
                              │
                    ┌─────────┴──────────┐
                    │  Nexus Command     │
                    │  Center (the hub)  │
                    └────────────────────┘
```

Each app is fully usable on its own. The integration is opt-in: a checkbox in
the secondary apps that says "sync to Nexus." When enabled, every save is
mirrored to the shared Supabase project, and Nexus picks up the change within
about 1.5 seconds via Realtime.

Row-Level Security means even though every app uses the same anon/publishable
key, each signed-in user only sees their own rows.

---

# Nexus Command Center

The hub of the suite. Five modules in one Android app, plus the cross-cutting
Weekly and Year Reviews that read from all of them.

## What it does

Five modules. Each works standalone, all feed the reviews and goals.

- **Finance** — Transactions, multi-category budgets, multi-currency portfolio
  with live quotes (Finnhub primary, Yahoo + CoinGecko fallback), net-worth
  tracking, compound-growth what-if simulator with adjustable rates and an
  inflation toggle. Watchlist with target-price alerts.
- **Studies** — Courses, grades (US 0–100% or IB 1–7), GPA calculation,
  CSV grade import with preview/confirm, study-session timer log,
  reading library with status flow.
- **Fitness** — Workout sessions, sets, weight, reps, RPE. Per-exercise
  progress charts, set count + volume heatmaps.
- **Tasks** — Due dates, priorities, overdue surfacing, completion tracking.
- **Goals** — Seven goal types (net worth, task count, workout count, reading
  count, study hours, lift PR, GPA) with progress derived live from each
  module — no manual progress updates.

Plus the cross-cutting:

- **Weekly Review** — Sunday 18:00 push reminder → cross-module recap screen
  with insights and week-vs-week deltas.
- **Year in Review** — Rolling 365-day window (not calendar-aligned), 365-day
  activity heatmaps per module, top-N categories / exercises, threshold-driven
  highlights.

## Stack

| Layer | Tech |
|---|---|
| Native shell | Capacitor 7 (Android-only) |
| Build | Vite |
| UI | React 18 + TypeScript + Tailwind |
| Theme | "Cyber Slate" — dark, monospace accents, glow highlights |
| State | Zustand (per-module stores) |
| Local DB | Dexie / IndexedDB |
| Cloud | Supabase Postgres + RLS + Realtime |
| Auth | Email/password + Google OAuth (PKCE deep-link), biometric, PIN |
| Data APIs | Finnhub, Yahoo Finance, CoinGecko, Frankfurter (FX) |

## Architecture highlights

- **Local-first.** Every read comes from local Dexie; UI never blocks on
  network. The cloud is a sync target and a multi-device convenience, not a
  prerequisite to launching the app.
- **Bidirectional Supabase sync.** Outbox-style queue drains to Postgres on
  reconnect, with FK-aware priority ordering. Inbound changes are picked up
  via Realtime `postgres_changes` events, coalesced on a 1.5 s timer,
  bulk-pulled into Dexie, and reload the Zustand stores so the UI refreshes
  without a navigation event.
- **LWW conflict resolution.** A `BEFORE UPDATE` trigger sets `updated_at`
  on every server-side mutation; pull-side merge keeps whichever row's
  `updated_at` is newer. Soft delete via `deleted_at`.
- **Cross-app writes.** External apps in the suite (Limelog, StudyDesk) write
  directly into the same `workout_sessions` / `subjects` / `grades` /
  `study_sessions` tables. No middleware, no proxy — RLS plus a shared signed
  user is the entire integration contract.

## Security model

This app holds finance, study, fitness, and task data — the security posture
is deliberate, documented, and audited.

- **Auth.** Supabase email/password + Google OAuth (PKCE flow, deep-link
  callback into the Android scheme). Sessions persist via Capacitor
  Preferences (SharedPreferences-backed) rather than WebView localStorage.
- **Device lock.** Biometric unlock via the platform fingerprint/face API,
  with a 6-digit PIN fallback. The PIN is hashed with PBKDF2-SHA256
  (250 000 iterations, per-PIN random salt), stored in a versioned format
  (`v2:salt:hash`). Constant-time compare. Tiered brute-force lockouts:
  5 wrong PINs → 30 s, 10 → 5 min, 20 → 15 min, persisted across app
  restarts.
- **At rest.** IndexedDB is plaintext on disk (relies on Android File-Based
  Encryption + the device PIN/biometric). Auto-backup is disabled in the
  AndroidManifest so the DB never gets uploaded to Google Drive backup
  quota. Real at-rest encryption (dexie-encrypted / SQLCipher) is on the
  roadmap.
- **In transit.** TLS 1.3 to Supabase and every data API. Cleartext traffic
  is blocked at the manifest level.
- **Content Security Policy.** Strict CSP `<meta>` restricts script execution
  to same-origin and enumerates every host the app is allowed to call.
- **API keys.** No keys ship in source. Users add their own Finnhub key in
  Settings → API Keys (BYO-key model). All keys are sent via the
  `X-Finnhub-Token` header, never as query-string parameters.
- **Pre-commit hook.** A zero-dependency Node script
  (`scripts/check-secrets.mjs`) scans every staged commit for known secret
  patterns (AWS, Stripe, GitHub, OpenAI, Anthropic, JWT shapes, and
  heuristic key-shaped assignments) and blocks the commit if anything
  suspicious is found. Bypass via `// pragma: allowlist secret`.

## Local development

Prerequisites: Node 20+, Android Studio (for the native build), a Supabase
project of your own (don't ship the publishable key in this repo — it points
at the maintainer's project).

```bash
npm install
npm run dev          # Vite dev server on localhost:5173 (LAN_DEV=1 to expose)
npm run cap:sync     # build + sync into android/
npm run cap:open     # opens Android Studio
```

The pre-commit hook needs a one-time wiring after clone:

```bash
git config core.hooksPath .githooks
```

## Repo layout

```
src/
  api/           Data providers (Finnhub, Yahoo, CoinGecko, Frankfurter, cache)
  components/    Shared UI (cards, heatmaps, navigation)
  db/            Dexie schema + sync queue
  lib/           Pure utilities — weeklyReview, yearReview, goals, projection,
                 cloudSync, realtime, supabase client, notifications
  screens/       Routed pages (Dashboard, finance/, studies/, fitness/, tasks/,
                 WeeklyReview, YearReview, Goals, Settings, LockScreen, auth/)
  store/         Zustand stores per module + auth + sync + settings
  types/         Cross-cutting TypeScript types
android/         Capacitor-generated native project (tracked so manifest
                 hardening survives `cap sync`)
scripts/         Build / tooling scripts (icons, secret detection)
```

## Status

Released and in active development. All three apps ship together on a shared
suite version, so a milestone lands across the suite rather than app by app.
See [Releases](https://github.com/Limecore-Studio/nexus-command-center/releases) for
the current version and changelog — Android APKs and the Electron desktop
build are attached there.

The integration contracts for the sibling apps (Limelog and StudyDesk) live
in private working docs; ask [@Limekana](https://github.com/Limekana) if
you're building something that needs to write into the same Supabase backend.

## Support

The Nexus OS suite is free, open source and ad-free. If it's useful to you, you can support development on Ko-fi — it goes straight back into building the suite.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/J6K8240SNW)

## License

Personal project — no license declared yet. Code is here to read; ask
before reusing.

---

_Part of the Limecore Nexus OS suite. See [Limelog](https://github.com/Limecore-Studio/limelog)
and [StudyDesk](https://github.com/Limecore-Studio/StudyDesk) for the companion apps._
