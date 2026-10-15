# Plan: fork of `vscode-claude-token-usage-bar`

Base: https://github.com/nayawoonge/vscode-claude-token-usage-bar (MIT, single `extension.js`, no build step)

Goal: one status bar item showing
1. context window fill of the current session (exists),
2. prompt cache state (warm / cold),
3. a flashing "Compact before closing" nudge when it's worth it,
4. 5-hour / 7-day plan usage.

Must work on Windows, macOS and Linux. Work in small steps; test each step in the Extension Development Host (F5) before moving on.

---

## What the current code already does (reviewed)

- Finds sessions under `~/.claude/projects/<encoded-project>/*.jsonl`, picks the newest file for the current workspace (`scope: workspace`), falls back to all logs if no match.
- Context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the last usage record. This matches Claude Code's own `used_percentage` formula, so the cold-cache turn is counted correctly.
- Context window size from a hard-coded model regex table, fallback setting `contextWindow` (default 1M).
- "Today" = sum of input + output + cache tokens across today's entries.
- Tooltip with per-project totals. Yellow below 25% free, red below 10% free.
- Refreshes every 3 s by re-reading whole files.

## Issues found to verify / fix first

1. **Windows workspace matching (likely bug).** `workspaceProjectDir()` encodes `workspaceFolders[0].uri.fsPath`. VS Code's `fsPath` normally lowercases the drive letter (`c:\...` -> `c--...`), while Claude Code's folder is probably `C--...`. On mismatch it silently falls back to "newest log anywhere". Verify by listing `%USERPROFILE%\.claude\projects`; fix with case-insensitive compare.
2. **Long paths.** Claude Code truncates encoded names over 200 chars and appends a hash. Not handled; low priority, but fall back gracefully.
3. **`CLAUDE_CONFIG_DIR` ignored.** Paths are hard-coded to `~/.claude`. Respect the env var everywhere (projects dir, `.claude.json`, credentials).
4. **Model table outdated.** Missing e.g. `opus-5`, `opus-5-5`, `haiku-5-5`. Verify actual window sizes for the models you use rather than guessing; unknown models should show the fallback and say so in the tooltip.
5. **After `/compact`.** The last usage record is the pre-compaction one until the next response, so the bar shows the old high value. Detect a compaction marker in the transcript if one exists, else accept and note it.
6. **Subagent entries.** Check whether subagent usage lines can appear in the main transcript (e.g. a sidechain flag). If so, skip them in `lastContext()`.
7. **Performance.** Re-reading full transcripts every 3 s is wasteful on large sessions. Read only the tail of the active file for `lastContext()`; keep the mtime cache for totals.

## Step 0 — Fork setup

- Fork/clone, keep the MIT copyright notice, add your own.
- Change `name`, `displayName`, `publisher` in `package.json` so it doesn't collide with the original if both are installed.
- Run with F5 against a workspace where you use Claude Code.
- **Test:** item shows the same numbers as the original.

## Step 1 — Fix issues 1, 3, 7 (and 6 if confirmed)

- **Test (Windows):** tooltip "Source" names a session file from *this* project, not another one.
- **Test:** CPU stays negligible with a large session open.

## Step 2 — Cache state (warm / cold)

- Take the timestamp of the last assistant usage record in the current session.
- Determine TTL:
  - Preferred: if the usage record contains `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`, use whichever the last write used.
  - Else setting `claudeMonitor.cacheTtlMinutes` (default 60 for Pro/Max within plan usage; 5 when on usage credits or API key).
- Show remaining minutes, e.g. `cache 37m`, or `cache cold` with the token count that would be re-cached (= current context tokens).
- Treat this as an estimate; label it so in the tooltip.
- **Test:** send a message, minutes count down; compare with the clock icon in the Claude panel.

## Step 3 — "Compact before closing" nudge

Settings:
- `claudeMonitor.compactNudge.enabled` (default `true`)
- `claudeMonitor.compactNudge.minContextTokens` (default `100000`)
- `claudeMonitor.compactNudge.intervalMinutes` (default `5`)
- `claudeMonitor.compactNudge.flashSeconds` (default `10`)

Behaviour:
- Fire only when context >= threshold **and** cache is warm (compacting is cheap then). When cold, don't nudge; compacting costs the full re-read anyway.
- On fire: toggle text to `Compact before closing` and switch `backgroundColor` between `statusBarItem.warningBackground` and none every ~500 ms for `flashSeconds`, then restore normal display.
- VS Code allows only warning/error backgrounds for extensions; no custom colours.
- Note: an extension cannot detect that VS Code is about to close, so this is a periodic nudge by design.
- **Test:** set threshold low and interval to 1 min; verify flashing, no flashing on cold cache or small context, no stuck state after flashing.

## Step 4 — 5-hour / 7-day plan usage (Pro/Max)

The original README says this isn't available; that's outdated. Two sources, in this order:

1. **Claude Code's saved last reading** in `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json` (all platforms). Field layout is undocumented: inspect your file first and find the usage/quota object. Read-only, no network, no rate limit.
2. **Fallback, optional:** `GET https://api.anthropic.com/api/oauth/usage` using the OAuth token from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`).
   - Internal, undocumented endpoint; may change without notice.
   - Small hourly budget shared with Claude Code and other tools. Poll no more than every few minutes, only when the window is focused, honour `Retry-After` on HTTP 429.
   - **Unverified:** whether the credentials file exists on macOS or credentials live in the Keychain there. Check before relying on it; skip the fallback gracefully if no token file.
   - Never log or display the token.

Reference implementation for both sources (MIT): YahyaShareef's Claude Code Usage Tracker (https://marketplace.visualstudio.com/items?itemName=YahyaShareef.claude-code-usage-tracker). Read its source rather than guessing field names.

Display: `5h 23% · 7d 41%`, reset times in the tooltip. Mark stale readings (older than X minutes) in the tooltip.

- **Test:** values match `/usage` in the Claude panel within a few percent.

## Step 5 — Layout and polish

- Suggested text: `Ctx ▰▰▰▱▱▱ 48% · cache 37m · 5h 23% 7d 41%`
- Setting per segment to show/hide (keep "Today" optional).
- Tooltip: context details, cache details, plan windows with reset times, source file, "estimates" disclaimer.
- Package with `npx @vscode/vsce package`, install the `.vsix`.

## Out of scope / known limits

- No automatic `/compact`: no hook or extension API can trigger it.
- No custom close-confirmation dialog: VS Code's API can't veto window close. Use `"window.confirmBeforeClose": "always"` as a generic pause.
- All transcript-based numbers rely on Claude Code's JSONL format, which isn't a stable public interface.
