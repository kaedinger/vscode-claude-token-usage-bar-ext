# Claude Token Usage Bar Ext

A fork of [Claude Token Usage Bar](https://github.com/nayawoonge/vscode-claude-token-usage-bar) by nayawoonge (MIT).

One status bar item for Claude Code:

```
Ctx ▰▰▰▱▱▱ 48%  ·  cache 37m  ·  5h 23% 7d 41%
```

- **Context:** how full the current session's context window is. The window size comes from the model (current models have 1M; Haiku 4.5 has 200k). The item turns yellow below 25% free and red below 10% free. After `/compact` it shows `Ctx compacted` until the next response.
- **Cache:** estimated minutes left before the prompt cache expires, or `cache cold`. The TTL comes from the last cache write in the transcript (1 h or 5 min), or from `vscodeClaudeTokenUsageBarExt.cacheTtlMinutes`.
- **Compact nudge:** while the context is large and the cache is still warm, the item periodically flashes a reminder (default **Compact before closing**, configurable via `vscodeClaudeTokenUsageBarExt.compactNudge.message`). Compacting is cheap then; once the cache has expired, the next turn re-reads the whole context anyway. An extension can't tell when VS Code is about to close, so this is a periodic reminder.
- **Plan usage:** 5-hour and 7-day utilization (Pro/Max) from Claude Code's last saved reading in `.claude.json`. Claude Code updates it during normal use and on `/usage`. Hover the item to see reset times; readings older than `vscodeClaudeTokenUsageBarExt.planUsage.staleMinutes` are marked stale.

Hover the item for details, plus a per-project token chart. Click it to refresh.

All numbers are estimates from Claude Code's local files (`~/.claude`, or `$CLAUDE_CONFIG_DIR`). Their format isn't a stable public interface and may change with a Claude Code update.

## Install

Search for **Claude Token Usage Bar Ext** in the Extensions view (VS Code Marketplace, or Open VSX for VSCodium, Cursor and similar editors). Updates then arrive automatically.

Each release's `.vsix` is also attached to [GitHub Releases](https://github.com/kaedinger/vscode-claude-token-usage-bar-ext/releases): **Extensions → ··· → Install from VSIX…**. A `.vsix` install doesn't update automatically.

## Optional: plan usage from the API

`vscodeClaudeTokenUsageBarExt.planUsage.apiFallback` (off by default) fetches plan usage from Anthropic's internal `api/oauth/usage` endpoint when the saved reading is stale. It uses Claude Code's OAuth token from `.credentials.json`.

- The endpoint is undocumented and may change or disappear.
- It has a small hourly budget shared with Claude Code. The extension polls at most every `vscodeClaudeTokenUsageBarExt.planUsage.pollMinutes` (min. 2), only while the window is focused, and honours `Retry-After`.
- On macOS Claude Code keeps the token in the Keychain, so the fallback is skipped there.
- The token is never logged or displayed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vscodeClaudeTokenUsageBarExt.showContext` | `true` | Show the context gauge. |
| `vscodeClaudeTokenUsageBarExt.showCache` | `true` | Show the cache state. |
| `vscodeClaudeTokenUsageBarExt.showPlanUsage` | `true` | Show 5h / 7d plan usage. |
| `vscodeClaudeTokenUsageBarExt.showTodayUsage` | `false` | Show today's token total. |
| `vscodeClaudeTokenUsageBarExt.autoDetectContextWindow` | `true` | Detect the window size from the model. |
| `vscodeClaudeTokenUsageBarExt.contextWindow` | `1000000` | Fallback window size for unknown models. |
| `vscodeClaudeTokenUsageBarExt.cacheTtlMinutes` | `60` | TTL when the transcript doesn't say. Use 5 on usage credits or an API key. |
| `vscodeClaudeTokenUsageBarExt.compactNudge.enabled` | `true` | Enable the nudge. |
| `vscodeClaudeTokenUsageBarExt.compactNudge.minContextTokens` | `100000` | Minimum context size to nudge. |
| `vscodeClaudeTokenUsageBarExt.compactNudge.intervalMinutes` | `5` | Minutes between nudges. |
| `vscodeClaudeTokenUsageBarExt.compactNudge.flashSeconds` | `10` | Flash duration. |
| `vscodeClaudeTokenUsageBarExt.compactNudge.message` | `$(fold) Compact before closing` | Text shown while flashing. Supports `$(icon)` names. |
| `vscodeClaudeTokenUsageBarExt.planUsage.staleMinutes` | `15` | Age after which a reading counts as stale. |
| `vscodeClaudeTokenUsageBarExt.planUsage.apiFallback` | `false` | See above. |
| `vscodeClaudeTokenUsageBarExt.planUsage.pollMinutes` | `5` | Minimum minutes between API requests. |
| `vscodeClaudeTokenUsageBarExt.scope` | `workspace` | `workspace` = this project's newest session; `global` = newest anywhere. |
| `vscodeClaudeTokenUsageBarExt.barWidth` | `6` | Gauge width in characters. |
| `vscodeClaudeTokenUsageBarExt.alignment` | `right` | Status bar side. |
| `vscodeClaudeTokenUsageBarExt.refreshMs` | `3000` | Refresh interval (ms). Only newly appended log data is read. |

Settings and commands use their own `vscodeClaudeTokenUsageBarExt.*` IDs, so this fork can be installed next to the original. Settings from the original (`claudeMonitor.*`) are not carried over.

## Commands

- **Claude Token Usage Bar Ext: Refresh Now** — update immediately (same as clicking the item).
- **Claude Token Usage Bar Ext: Show/Hide** — toggle the status bar item.

## Known limits

- The extension can't run `/compact` itself; no hook or extension API can trigger it.
- VS Code can't veto a window close. `"window.confirmBeforeClose": "always"` gives a generic pause.

## Build

Pushing a `v*` tag builds the `.vsix` on GitHub Actions, attaches it to a GitHub Release and publishes to Open VSX (token in the `OVSX_PAT` secret) and the Marketplace (Microsoft Entra ID sign-in via a managed identity, no stored token). To build locally (needs Node):

```
npx @vscode/vsce package
```

## License

MIT
