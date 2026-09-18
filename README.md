<div align="center">

<img src="assets/icon.png" width="104" alt="">

# OTel Monitor

**See what Claude Code's telemetry actually sends — a macOS app**

[![macOS](https://img.shields.io/badge/macOS-13%2B-black)](#install)
[![Universal](https://img.shields.io/badge/build-universal-black)](#install)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

[한국어](README.ko.md) · **English**

<img src="assets/banner.png" width="100%" alt="">

</div>

---

## Why

Turn on Claude Code's OpenTelemetry and usage metrics start flowing to a collector on
a timer. Only numbers go out — no prompts, no code — but there was no way to confirm that.

- Nothing about the sends lands on disk, success or failure
- Failures only surface with `claude --debug`
- Change a setting and you can't tell what actually changed

So I put something in the middle and watched what goes past.

## How it works

It receives OTLP locally, decodes it, then passes the bytes through to whatever collector
you configure. Your existing collection keeps working; you just get to see inside.

```
Claude Code
    │  OTLP/HTTP (protobuf)
    ▼
OTel Monitor  :4319     ← decode · record · leak detection
    │  relayed as-is
    ▼
your collector (optional)
```

Headers pass through untouched, so the collector sees no difference.
Leave the forward address empty and it becomes a **local-only viewer**.

## Screenshot

<div align="center">
<img src="assets/screenshot.png" width="100%" alt="">
</div>

| Area | What it shows |
|---|---|
| **Stats** | Requests · bytes · tokens · cost · sessions · commits/PRs · code changes · active time · forward failures · content leaks. Column count adapts to window width |
| **Filters** | Filter the stream, stats, and charts together by any attribute — `user.email`, `unit`, `model`, and so on |
| **Stream** | Every request with time, signal, size, metric names, and response |
| **Inspector** | Full attributes of the selected request. Identifying fields are color-coded. Drag the divider to resize |
| **Charts** | Tokens (input/output), cost, active time, code changes. Hover to read every series at that point. This run / 7 / 30 / 90 days |
| **Settings** | Port · forward address · forward on/off, retention, export, update check, config diagnostics |
| **Menu bar** | Stays in the menu bar after you close the window. Right-click for a live summary |

### Leak detection

A banner appears when any of these show up in a payload:

- **The logs signal itself** — meaning `OTEL_LOGS_EXPORTER` got turned on
- **Content fields** — `prompt`, `response`, `tool_parameters`, `error`, `api_request_body`
  with a real value (not `<REDACTED>`)

Settings can also read your `settings.json` and tell you whether any of the six
content-exposure keys are enabled.

### Daily history

Daily totals per account, so you can see 7/30/90-day trends.
Request bodies are never stored — there's no reason to pile up data nobody reads.

```
~/Library/Application Support/dev.seungwoo.otel-monitor/history.json
```

Retention defaults to 90 days, adjustable in settings; lowering it prunes immediately.
There's a clear-all button too. A year of use stays under 1 MB.

### Auto-update

You get a notice when a new version ships. Nothing downloads until you confirm.

### Menu bar

Close the window and the app stays in the menu bar, still receiving. Right-click the icon
for current numbers; left-click toggles the window. Leak and forward-failure lines only
appear when there's something to report.

### Stream follow

Like `tail -f` — new entries are selected automatically and the inspector follows along.
Click a specific entry to stop; hit "최신으로" (Latest) to resume.

## Install

Grab the `.dmg` from [Releases](../../releases) and drag the app to `Applications`.
Universal build, so Intel and Apple Silicon both work (macOS 13+).

### Connect Claude Code

Add this to the `env` block of your settings file. The path depends on `CLAUDE_CONFIG_DIR`
and defaults to `~/.claude/settings.json` — the app's settings tab will find it for you.

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4319"
  }
}
```

Already sending to a collector? Put its address in **forward address** and the app will
relay everything through, leaving your collection intact.

> Running sessions won't pick this up. Start `claude` in a new terminal.
> The first send takes up to a minute (default export interval).

## Build it yourself

```bash
pnpm install
pnpm tauri dev
pnpm tauri build
```

Needs Rust 1.77+ and Node 20+. For signed and notarized releases see
[docs/RELEASE-macos.md](docs/RELEASE-macos.md) — certificates and passwords are read from
environment variables and never committed.

## What gets captured

Claude Code emits eight metrics. That's all of them.

| Metric | Meaning |
|---|---|
| `session.count` | Sessions started |
| `token.usage` | Tokens (input / output / cacheRead / cacheCreation) |
| `cost.usage` | Cost in USD |
| `lines_of_code.count` | Lines changed (added / removed) |
| `commit.count` · `pull_request.count` | Commits and PRs |
| `code_edit_tool.decision` | Edit permission accepted / rejected |
| `active_time.total` | Active seconds |

Numbers only — no conversation content. But when you're signed in,
`user.email` and `organization.id` ride along. The inspector flags those separately.

## Things I learned building this

- **Headless (`claude -p`) sends nothing.** Metrics only export from interactive sessions.
  Cost me a while to figure out.
- **Claude Code resends the running total every time** (cumulative temporality), so you
  overwrite rather than add. I wrote `+=` first and watched commit counts double.
- `OTEL_METRICS_EXPORTER` takes a comma-separated list like `console,otlp`,
  but the docs never say where console output goes.
- The `telemetry/` folder in your Claude config is Anthropic's own analytics
  (`1p_failed_events`), unrelated to the OTel pipeline here. Easy to confuse.
- **Tauri v2 ignores `TAURI_SIGNING_PRIVATE_KEY_PATH`** — it wants the key *contents* in
  `TAURI_SIGNING_PRIVATE_KEY`.
- **GitHub turns spaces in asset names into dots**, so `latest.json` URLs have to match
  or the updater 404s silently.

## Layout

```
src-tauri/src/
  otlp.rs     OTLP receive · protobuf decode · leak checks · routing
  state.rs    capture buffer · cumulative aggregation · forwarding
  history.rs  daily records · retention
  tray.rs     menu bar icon and summary
  lib.rs      Tauri commands · server startup
src/
  index.html  UI · theme tokens
  main.js     rendering · SVG charts · filters · resizer
scripts/
  build-macos-release.sh   sign · notarize · staple
  publish-release.sh       upload release · generate latest.json
```

Protobuf decoding goes through the `opentelemetry-proto` crate. I prototyped by scraping
strings out of the binary first, but the values kept drifting, so I rewrote it.

## What it doesn't do

- **Never stores request bodies.** Captures live in memory (500 max) and vanish when the
  app quits. Only daily per-account totals and leak records hit disk. Export to JSON/CSV
  if you need the raw data.
- **Never modifies what passes through.** This watches; it doesn't block.
- **Nothing is forwarded while the app is closed.** Unavoidable when you sit in the middle.

## License

[MIT](LICENSE)
