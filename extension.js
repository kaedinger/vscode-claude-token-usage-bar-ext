const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

let item; // single combined status bar item
let timer;
let visible = true;

// path -> per-file scan state (see scanFile). Files are read incrementally:
// only bytes appended since the last refresh are parsed.
const fileCache = new Map();

// Compact nudge state.
let flashTimer = null;
let flashUntil = 0;
let lastNudgeAt = Date.now(); // first nudge comes one interval after activation

// Plan usage state.
let claudeJsonCache = { path: null, mtime: 0, reading: null };
let apiReading = null; // { fetchedAtMs, utilization }
let apiNextAllowedAt = 0;
let apiInFlight = false;
let apiLastError = null;

function activate(context) {
  const align =
    getCfg().get('alignment', 'right') === 'left'
      ? vscode.StatusBarAlignment.Left
      : vscode.StatusBarAlignment.Right;

  // A single item so nothing (Copilot, encoding, Ln/Col…) can wedge between the parts.
  item = vscode.window.createStatusBarItem(align, 100);
  item.command = 'claudeMonitor.refresh';

  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMonitor.refresh', update),
    vscode.commands.registerCommand('claudeMonitor.toggle', () => {
      visible = !visible;
      update();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeMonitor')) {
        restartTimer();
        update();
      }
    })
  );

  restartTimer();
  update();
}

function getCfg() {
  return vscode.workspace.getConfiguration('claudeMonitor');
}

function restartTimer() {
  if (timer) clearInterval(timer);
  const ms = Math.max(500, getCfg().get('refreshMs', 3000));
  timer = setInterval(update, ms);
}

// ---------------------------------------------------------------------------
// Paths (respect CLAUDE_CONFIG_DIR everywhere)
// ---------------------------------------------------------------------------

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsDir() {
  return path.join(configDir(), 'projects');
}

// Claude Code keeps its global state file next to the config dir when
// CLAUDE_CONFIG_DIR is set, otherwise in the home directory.
function claudeJsonCandidates() {
  const out = [];
  if (process.env.CLAUDE_CONFIG_DIR) out.push(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  out.push(path.join(os.homedir(), '.claude.json'));
  return out;
}

function credentialsPath() {
  return path.join(configDir(), '.credentials.json');
}

// Session transcripts are named <uuid>.jsonl. Anything else in the folder
// (e.g. sync-tool conflict copies) would double-count, so skip it.
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// All session logs under <config>/projects, with mtime and size.
function allLogs() {
  const root = projectsDir();
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!SESSION_FILE.test(f)) continue;
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        out.push({ path: p, mtime: st.mtimeMs, size: st.size, project: d.name });
      } catch (_) {
        /* ignore */
      }
    }
  }
  return out;
}

// Claude Code stores a project's sessions under a folder whose name is the
// project path with every non-alphanumeric char replaced by '-'.
// e.g. /Users/me/src/app -> -Users-me-src-app, W:\dev\app -> W--dev-app.
// Names over 200 chars are truncated and get a hash suffix, so for those we
// match on the 200-char prefix.
const MAX_DIR_NAME = 200;

function encodeProjectPath(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function workspaceTargets() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return [];
  return folders.map((f) => encodeProjectPath(f.uri.fsPath).toLowerCase());
}

// VS Code lowercases the Windows drive letter in fsPath while Claude Code may
// not (both `w--x` and `W--x` folders occur), so compare case-insensitively.
function matchesTarget(project, targets) {
  const name = project.toLowerCase();
  return targets.some((t) =>
    t.length > MAX_DIR_NAME ? name.startsWith(t.slice(0, MAX_DIR_NAME)) : name === t
  );
}

// Logs limited to the current VS Code workspace's project(s), if we can find
// them. Falls back to all logs when there is no workspace or no matching folder.
function scopedLogs(logs) {
  if (getCfg().get('scope', 'workspace') !== 'workspace') return { logs, matched: false };
  const targets = workspaceTargets();
  if (!targets.length) return { logs, matched: false };
  const matched = logs.filter((l) => matchesTarget(l.project, targets));
  return matched.length ? { logs: matched, matched: true } : { logs, matched: false };
}

function latestLog(logs) {
  let best = null;
  for (const l of logs) if (!best || l.mtime > best.mtime) best = l;
  return best;
}

// ---------------------------------------------------------------------------
// Transcript scanning
// ---------------------------------------------------------------------------

function usageOf(o) {
  return (o && o.message && o.message.usage) || (o && o.usage) || null;
}

function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function freshEntry() {
  return {
    size: 0,
    mtime: 0,
    offset: 0,
    seen: new Set(), // message ids already counted (one message spans several lines)
    total: 0,
    byDay: {},
    last: null, // last main-chain usage record: { tokens, model, ts }
    lastTtlMin: null, // TTL of the last cache write: 60 or 5
    compactAfterLast: null, // compact_boundary seen after `last`: { ts, preTokens }
  };
}

function processLine(entry, line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch (_) {
    return; // partial or malformed line
  }

  if (o.type === 'system' && o.subtype === 'compact_boundary') {
    const meta = o.compactMetadata || {};
    entry.compactAfterLast = {
      ts: Date.parse(o.timestamp) || Date.now(),
      preTokens: meta.preTokens || null,
    };
    return;
  }

  const u = usageOf(o);
  if (!u || u.input_tokens == null) return;
  const model = (o.message && o.message.model) || o.model || null;
  // Claude Code writes zero-usage "<synthetic>" messages for local errors.
  if (model === '<synthetic>') return;

  const ts = Date.parse(o.timestamp) || 0;
  const id = (o.message && o.message.id) || o.requestId || o.uuid;

  // Totals: count each API message once.
  if (!id || !entry.seen.has(id)) {
    if (id) entry.seen.add(id);
    const sum =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    entry.total += sum;
    if (ts) {
      const k = localDayKey(ts);
      entry.byDay[k] = (entry.byDay[k] || 0) + sum;
    }
  }

  // Context and cache state come from the main chain only.
  if (o.isSidechain) return;
  entry.last = {
    // Same formula as Claude Code's own used_percentage.
    tokens:
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0),
    model,
    ts,
  };
  entry.compactAfterLast = null;
  const cc = u.cache_creation;
  if (cc) {
    if (cc.ephemeral_1h_input_tokens > 0) entry.lastTtlMin = 60;
    else if (cc.ephemeral_5m_input_tokens > 0) entry.lastTtlMin = 5;
  }
}

// Bring the cache entry for a log up to date, reading only what was appended.
function scanFile(l) {
  let entry = fileCache.get(l.path);
  if (entry && entry.size === l.size && entry.mtime === l.mtime) return entry;
  if (!entry || l.size < entry.offset) entry = freshEntry(); // new or rewritten

  if (l.size > entry.offset) {
    let fd;
    try {
      fd = fs.openSync(l.path, 'r');
      const len = l.size - entry.offset;
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, entry.offset);
      // Only consume complete lines; a trailing partial line is re-read next time.
      const lastNl = buf.lastIndexOf(0x0a, read - 1);
      if (lastNl >= 0) {
        const text = buf.toString('utf8', 0, lastNl);
        for (const line of text.split('\n')) if (line) processLine(entry, line);
        entry.offset += lastNl + 1;
      }
    } catch (_) {
      /* unreadable right now; retry next refresh */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  entry.size = l.size;
  entry.mtime = l.mtime;
  fileCache.set(l.path, entry);
  return entry;
}

// Scan every log, return per-project totals and today's totals.
function collectStats(logs) {
  const today = localDayKey(Date.now());
  const perAll = {};
  const perToday = {};
  let todayTotal = 0;
  const live = new Set();
  for (const l of logs) {
    live.add(l.path);
    const e = scanFile(l);
    if (e.total > 0) perAll[l.project] = (perAll[l.project] || 0) + e.total;
    const t = e.byDay[today] || 0;
    if (t > 0) {
      perToday[l.project] = (perToday[l.project] || 0) + t;
      todayTotal += t;
    }
  }
  for (const p of fileCache.keys()) if (!live.has(p)) fileCache.delete(p);
  const sorted = (o) =>
    Object.entries(o)
      .map(([project, tokens]) => ({ project, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
  return { projects: sorted(perAll), todayTotal, todayByProject: sorted(perToday) };
}

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

// Known model context-window sizes (tokens), matched by substring on the model
// id. Source: Anthropic model table (2026-10). Current models are all 1M.
const MODEL_WINDOWS = [
  [/haiku-4-5|opus-4-5|sonnet-4-5|opus-4-1|opus-4-2025|sonnet-4-2025|claude-3/, 200000],
  [/fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5/, 1000000],
];

function windowForModel(model) {
  if (!model) return null;
  if (/\[1m\]/i.test(model)) return 1000000;
  for (const [re, win] of MODEL_WINDOWS) if (re.test(model)) return win;
  return null;
}

// ---------------------------------------------------------------------------
// Prompt cache (estimate)
// ---------------------------------------------------------------------------

function cacheState(entry, cfg) {
  if (!entry || !entry.last || !entry.last.ts) return null;
  const ttlMin = entry.lastTtlMin || cfg.get('cacheTtlMinutes', 60);
  const fromRecord = !!entry.lastTtlMin;
  const expiresAt = entry.last.ts + ttlMin * 60000;
  const remainingMs = expiresAt - Date.now();
  return { ttlMin, fromRecord, expiresAt, remainingMs, warm: remainingMs > 0 };
}

// ---------------------------------------------------------------------------
// Plan usage (5-hour / 7-day)
// ---------------------------------------------------------------------------

// Claude Code's last saved reading in .claude.json (`cachedUsageUtilization`).
function readSavedUsage() {
  for (const p of claudeJsonCandidates()) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (_) {
      continue;
    }
    if (claudeJsonCache.path === p && claudeJsonCache.mtime === st.mtimeMs) return claudeJsonCache.reading;
    let reading = null;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const c = j.cachedUsageUtilization;
      if (c && c.utilization) reading = { fetchedAtMs: c.fetchedAtMs || 0, utilization: c.utilization, source: 'Claude Code' };
    } catch (_) {
      /* file mid-write; keep the previous reading */
      if (claudeJsonCache.path === p) return claudeJsonCache.reading;
    }
    claudeJsonCache = { path: p, mtime: st.mtimeMs, reading };
    return reading;
  }
  return null;
}

// Optional fallback: the internal (undocumented) OAuth usage endpoint. Polled
// sparingly, only while the window is focused, honouring Retry-After. The token
// is read from the credentials file and never logged or displayed.
function maybeFetchUsage(cfg, saved) {
  if (!cfg.get('planUsage.apiFallback', false)) return;
  if (apiInFlight || !vscode.window.state.focused) return;
  const now = Date.now();
  if (now < apiNextAllowedAt) return;
  const staleMs = cfg.get('planUsage.staleMinutes', 15) * 60000;
  const newest = Math.max((saved && saved.fetchedAtMs) || 0, (apiReading && apiReading.fetchedAtMs) || 0);
  if (now - newest < staleMs) return;

  let token;
  try {
    const c = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    const o = c.claudeAiOauth || {};
    if (o.expiresAt && o.expiresAt < now) {
      apiLastError = 'OAuth token expired (Claude Code refreshes it on its next request)';
      apiNextAllowedAt = now + 5 * 60000;
      return;
    }
    token = o.accessToken;
  } catch (_) {
    token = null;
  }
  if (!token) {
    apiLastError = 'no credentials file (on macOS Claude Code keeps the token in the Keychain)';
    apiNextAllowedAt = now + 60 * 60000;
    return;
  }

  const pollMs = Math.max(2, cfg.get('planUsage.pollMinutes', 5)) * 60000;
  apiNextAllowedAt = now + pollMs;
  apiInFlight = true;
  const req = https.request(
    'https://api.anthropic.com/api/oauth/usage',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      timeout: 15000,
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        apiInFlight = false;
        if (res.statusCode === 429) {
          const ra = parseInt(res.headers['retry-after'], 10);
          apiNextAllowedAt = Date.now() + Math.max(pollMs, (isNaN(ra) ? 600 : ra) * 1000);
          apiLastError = 'rate limited (429)';
          return;
        }
        if (res.statusCode !== 200) {
          apiLastError = `HTTP ${res.statusCode}`;
          return;
        }
        try {
          const j = JSON.parse(body);
          const u = j.utilization || j;
          if (u.five_hour || u.seven_day) {
            apiReading = { fetchedAtMs: Date.now(), utilization: u, source: 'usage API' };
            apiLastError = null;
            update();
          }
        } catch (_) {
          apiLastError = 'unexpected response';
        }
      });
    }
  );
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => {
    apiInFlight = false;
    apiLastError = e.message;
  });
  req.end();
}

function planUsage(cfg) {
  const saved = readSavedUsage();
  maybeFetchUsage(cfg, saved);
  const candidates = [saved, apiReading].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.fetchedAtMs > a.fetchedAtMs ? b : a));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function bar(pct, width) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  // ▰ filled / ▱ empty — reads as a segmented gauge; filled segments take the
  // status bar foreground color (light/white on dark themes).
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m <= 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// Turn a Claude Code project-dir name (e.g. "-Users-me-src-my-app") into a
// short, readable label. We can't perfectly decode (folder names contain
// dashes), so show the tail.
function projectLabel(dir) {
  let s = String(dir).replace(/^-+/, '');
  if (s.length > 26) s = '…' + s.slice(-26);
  return s;
}

// ---------------------------------------------------------------------------
// Compact nudge
// ---------------------------------------------------------------------------

function startFlash(seconds) {
  stopFlash();
  flashUntil = Date.now() + seconds * 1000;
  let on = false;
  item.text = '$(fold) Compact before closing';
  item.tooltip = 'Context is large and the prompt cache is still warm: running /compact now is cheap. ' +
    'Once the cache expires, the next turn re-reads the full context.';
  flashTimer = setInterval(() => {
    if (Date.now() >= flashUntil) {
      stopFlash();
      update();
      return;
    }
    on = !on;
    item.backgroundColor = on ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }, 500);
}

function stopFlash() {
  if (flashTimer) clearInterval(flashTimer);
  flashTimer = null;
  flashUntil = 0;
}

function maybeNudge(cfg, ctxTokens, cache, compacted) {
  if (!cfg.get('compactNudge.enabled', true)) return false;
  if (compacted || ctxTokens == null || !cache || !cache.warm) return false;
  if (ctxTokens < cfg.get('compactNudge.minContextTokens', 100000)) return false;
  const intervalMs = Math.max(1, cfg.get('compactNudge.intervalMinutes', 5)) * 60000;
  if (Date.now() - lastNudgeAt < intervalMs) return false;
  lastNudgeAt = Date.now();
  startFlash(Math.max(1, cfg.get('compactNudge.flashSeconds', 10)));
  return true;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function update() {
  if (!visible) {
    stopFlash();
    item.hide();
    return;
  }
  if (flashTimer) return; // the flash restores the normal display when it ends

  const cfg = getCfg();
  const cfgMax = cfg.get('contextWindow', 1000000);
  const autoDetect = cfg.get('autoDetectContextWindow', true);
  const width = cfg.get('barWidth', 6);
  const showContext = cfg.get('showContext', true);
  const showCache = cfg.get('showCache', true);
  const showPlan = cfg.get('showPlanUsage', true);
  const showToday = cfg.get('showTodayUsage', false);

  const logs = allLogs();
  const stats = collectStats(logs); // brings every file's cache entry up to date
  const scoped = scopedLogs(logs);
  const log = latestLog(scoped.logs);
  const entry = log ? fileCache.get(log.path) : null;

  const parts = [];
  const tip = ['### Claude Usage'];
  let bg;

  // --- Context window ---
  let ctxTokens = null;
  let compacted = false;
  if (!log) {
    parts.push('Claude: no log');
    tip.push(`No session logs found under \`${projectsDir()}\`.`);
  } else if (!entry || !entry.last) {
    parts.push('Claude: --');
    tip.push('No usage record found in the latest session log yet.');
  } else {
    const last = entry.last;
    ctxTokens = last.tokens;
    compacted = !!entry.compactAfterLast;
    const detected = autoDetect ? windowForModel(last.model) : null;
    let max = detected || cfgMax;
    let windowNote = detected ? 'auto-detected from model' : autoDetect ? 'unknown model, using `claudeMonitor.contextWindow`' : 'from `claudeMonitor.contextWindow`';
    if (ctxTokens > max && max < 1000000) {
      max = 1000000;
      windowNote = 'assumed 1M because usage exceeds the detected window';
    }
    const usedPct = Math.min(100, (ctxTokens / max) * 100);
    const leftPct = 100 - usedPct;

    if (compacted) {
      if (showContext) parts.push('Ctx compacted');
      const pre = entry.compactAfterLast.preTokens;
      tip.push(
        `**Context window**\n\n` +
          `- Compacted at ${fmtTime(entry.compactAfterLast.ts)}${pre ? ` (was ${pre.toLocaleString()} tokens)` : ''}\n` +
          `- New size is known after the next response.\n` +
          `- Model: \`${last.model || 'unknown'}\``
      );
    } else {
      if (showContext) parts.push(`Ctx ${bar(usedPct, width)} ${usedPct.toFixed(0)}%`);
      tip.push(
        `**Context window**\n\n` +
          `- Used: ${ctxTokens.toLocaleString()} / ${max.toLocaleString()} tokens (${usedPct.toFixed(1)}%)\n` +
          `- Remaining: ${(max - ctxTokens).toLocaleString()} tokens (${leftPct.toFixed(1)}%)\n` +
          `- Model: \`${last.model || 'unknown'}\` (window ${windowNote})`
      );
      if (showContext) {
        bg =
          leftPct < 10
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : leftPct < 25
              ? new vscode.ThemeColor('statusBarItem.warningBackground')
              : undefined;
      }
    }
  }

  // --- Prompt cache ---
  const cache = cacheState(entry, cfg);
  if (cache) {
    if (showCache) parts.push(cache.warm ? `cache ${fmtDuration(cache.remainingMs)}` : 'cache cold');
    const ttlSrc = cache.fromRecord ? 'from the last cache write' : 'from `claudeMonitor.cacheTtlMinutes`';
    tip.push(
      `**Prompt cache** _(estimate)_\n\n` +
        (cache.warm
          ? `- Warm, expires ~${fmtTime(cache.expiresAt)} (in ${fmtDuration(cache.remainingMs)})\n`
          : `- Cold since ~${fmtTime(cache.expiresAt)}. Next turn re-caches ~${fmt(ctxTokens || 0)} tokens.\n`) +
        `- Last response: ${fmtTime(entry.last.ts)}\n` +
        `- TTL: ${cache.ttlMin} min (${ttlSrc})`
    );
  }

  // --- Plan usage ---
  if (showPlan) {
    const r = planUsage(cfg);
    const u = r && r.utilization;
    const w5 = u && u.five_hour;
    const w7 = u && u.seven_day;
    if (w5 || w7) {
      const pct = (w) => (w && w.utilization != null ? `${Math.round(w.utilization)}%` : '--');
      parts.push(`5h ${pct(w5)} 7d ${pct(w7)}`);
      const ageMs = Date.now() - r.fetchedAtMs;
      const stale = ageMs > cfg.get('planUsage.staleMinutes', 15) * 60000;
      const reset = (w) => (w && w.resets_at ? `, resets ${fmtTime(Date.parse(w.resets_at))}` : '');
      tip.push(
        `**Plan usage**\n\n` +
          `- 5-hour: ${pct(w5)}${reset(w5)}\n` +
          `- 7-day: ${pct(w7)}${reset(w7)}\n` +
          `- Reading from ${r.source}, ${fmtDuration(ageMs)} ago${stale ? ' — **stale**' : ''}` +
          (apiLastError && cfg.get('planUsage.apiFallback', false) ? `\n- API fallback: ${apiLastError}` : '')
      );
    } else {
      tip.push('**Plan usage**\n\n- No saved reading yet. Run `/usage` in Claude Code once.');
    }
  }

  // --- Today ---
  if (showToday) parts.push(stats.todayTotal ? `Today ${fmt(stats.todayTotal)}` : 'Today --');
  if (stats.todayTotal) tip.push(`**Today:** ${stats.todayTotal.toLocaleString()} tokens`);

  // --- All-projects breakdown (visualized) ---
  if (stats.projects.length) {
    const maxTok = stats.projects[0].tokens || 1;
    const rows = stats.projects.map((p) => {
      const b = bar(Math.round((p.tokens / maxTok) * 100), 10);
      return `${b}  ${fmt(p.tokens).padStart(7)}  ${projectLabel(p.project)}`;
    });
    tip.push(
      `**All projects — token usage** (${stats.projects.length})\n\n` +
        '```\n' +
        rows.join('\n') +
        '\n```'
    );
  }

  if (log) {
    tip.push(
      `Source: \`${log.project}/${path.basename(log.path)}\`` +
        (scoped.matched ? '' : ' _(no session for this workspace; newest overall)_')
    );
  }
  tip.push('_Context, cache and plan numbers are estimates from local files. Click to refresh._');

  item.text = parts.join('  ·  ');
  item.tooltip = new vscode.MarkdownString(tip.join('\n\n'));
  item.backgroundColor = bg;
  item.show();

  maybeNudge(cfg, ctxTokens, cache, compacted);
}

function deactivate() {
  if (timer) clearInterval(timer);
  stopFlash();
}

module.exports = { activate, deactivate };
