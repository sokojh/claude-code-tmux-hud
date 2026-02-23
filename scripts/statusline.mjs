#!/usr/bin/env node
// Claude Code statusline — real-time HUD for tmux side panel
// Optimized: ~300ms invocation cycle, incremental transcript parsing, git cache
// No external dependencies. Node.js 18+ required.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOME = os.homedir();
// Session-isolated state: CLAUDE_PANEL_ID env -> per-session file
const PANEL_ID = process.env.CLAUDE_PANEL_ID || '';
const STATE_FILE = PANEL_ID ? `/tmp/claude-panel-${PANEL_ID}.json` : '/tmp/claude-panel-state.json';
const PARSE_CACHE = '/tmp/claude-statusline-cache.json';

// Independent cache directory (no plugin dependency)
const CACHE_DIR = path.join(HOME, '.claude', '.tmux-hud-cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ok */ }
const USAGE_CACHE_PATH = path.join(CACHE_DIR, 'usage-cache.json');
const KEYCHAIN_BACKOFF_PATH = path.join(CACHE_DIR, 'keychain-backoff');

// -- Colors --
const RST = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const MAG = '\x1b[35m';
const CYN = '\x1b[36m';
const B_BLU = '\x1b[94m';
const B_MAG = '\x1b[95m';

const green   = t => `${GRN}${t}${RST}`;
const yellow  = t => `${YLW}${t}${RST}`;
const red     = t => `${RED}${t}${RST}`;
const cyan    = t => `${CYN}${t}${RST}`;
const magenta = t => `${MAG}${t}${RST}`;
const dim     = t => `${DIM}${t}${RST}`;

const ctxColor   = p => p >= 85 ? RED : p >= 70 ? YLW : GRN;
const quotaColor = p => p >= 90 ? RED : p >= 75 ? B_MAG : B_BLU;

function coloredBar(pct, w = 10) {
  const f = Math.round((Math.min(100, Math.max(0, pct)) / 100) * w);
  const e = w - f;
  const grad = e >= 2 ? '\u2593\u2592' : e === 1 ? '\u2593' : '';
  const eAdj = Math.max(0, e - grad.length);
  return `${ctxColor(pct)}${'\u2588'.repeat(f)}${grad}${DIM}${'\u2591'.repeat(eAdj)}${RST}`;
}
function quotaBar(pct, w = 10) {
  const f = Math.round((Math.min(100, Math.max(0, pct)) / 100) * w);
  const e = w - f;
  const grad = e >= 2 ? '\u2593\u2592' : e === 1 ? '\u2593' : '';
  const eAdj = Math.max(0, e - grad.length);
  return `${quotaColor(pct)}${'\u2588'.repeat(f)}${grad}${DIM}${'\u2591'.repeat(eAdj)}${RST}`;
}
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// -- Stdin --
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join('');
  return raw.trim() ? JSON.parse(raw) : null;
}

function getModelName(s) { return s.model?.display_name ?? s.model?.id ?? 'Unknown'; }

function getContextPercent(s) {
  const n = s.context_window?.used_percentage;
  if (typeof n === 'number' && !Number.isNaN(n)) return Math.min(100, Math.max(0, Math.round(n)));
  const sz = s.context_window?.context_window_size;
  if (!sz || sz <= 0) return 0;
  const u = s.context_window?.current_usage;
  const t = (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
  return Math.min(100, Math.round((t / sz) * 100));
}

// -- Incremental Transcript Parsing (PERF: only read new bytes) --
function loadParseCache() {
  try {
    if (fs.existsSync(PARSE_CACHE)) return JSON.parse(fs.readFileSync(PARSE_CACHE, 'utf8'));
  } catch { /* ok */ }
  return null;
}

function saveParseCache(data) {
  try { fs.writeFileSync(PARSE_CACHE, JSON.stringify(data), 'utf8'); } catch { /* ok */ }
}

function parseTranscript(transcriptPath) {
  const empty = { tools: [], agents: [], todos: [], sessionStart: null };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;

  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return empty; }
  const fileSize = stat.size;

  // Check cache -- if file hasn't grown, reuse cached result
  const cache = loadParseCache();
  if (cache && cache.path === transcriptPath && cache.size === fileSize && cache.result) {
    return cache.result;
  }

  // Determine read offset (incremental) or full parse
  const prevOffset = (cache && cache.path === transcriptPath) ? (cache.size || 0) : 0;
  const toolMap = new Map();
  const agentMap = new Map();
  let latestTodos = [];
  let sessionStart = null;

  // Restore previous state if incremental
  if (prevOffset > 0 && cache?.result) {
    sessionStart = cache.result.sessionStart ? new Date(cache.result.sessionStart) : null;
    for (const t of (cache.result.tools || [])) toolMap.set(t.id, { ...t, startTime: new Date(t.startTime), endTime: t.endTime ? new Date(t.endTime) : undefined });
    for (const a of (cache.result.agents || [])) agentMap.set(a.id, { ...a, startTime: new Date(a.startTime), endTime: a.endTime ? new Date(a.endTime) : undefined });
    latestTodos = cache.result.todos || [];
  }

  try {
    // Read only new bytes (or full file if first time)
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(fileSize - prevOffset);
    fs.readSync(fd, buf, 0, buf.length, prevOffset);
    fs.closeSync(fd);

    const newContent = buf.toString('utf8');
    for (const line of newContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
        if (!sessionStart && entry.timestamp) sessionStart = ts;
        const content = entry.message?.content;
        if (!content || !Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            if (block.name === 'Task') {
              agentMap.set(block.id, { id: block.id, type: block.input?.subagent_type ?? 'unknown', model: block.input?.model, description: block.input?.description, status: 'running', startTime: ts });
            } else if (block.name === 'TodoWrite') {
              if (block.input?.todos && Array.isArray(block.input.todos)) latestTodos = [...block.input.todos];
            } else {
              const target = extractTarget(block.name, block.input);
              toolMap.set(block.id, { id: block.id, name: block.name, target, status: 'running', startTime: ts });
            }
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            const tool = toolMap.get(block.tool_use_id);
            if (tool) { tool.status = block.is_error ? 'error' : 'completed'; tool.endTime = ts; }
            const agent = agentMap.get(block.tool_use_id);
            if (agent) { agent.status = 'completed'; agent.endTime = ts; }
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* partial */ }

  const result = {
    tools: Array.from(toolMap.values()).slice(-20),
    agents: Array.from(agentMap.values()).slice(-10),
    todos: latestTodos,
    sessionStart,
  };

  // Save cache with new offset
  saveParseCache({ path: transcriptPath, size: fileSize, result });
  return result;
}

function extractTarget(name, input) {
  if (!input) return undefined;
  switch (name) {
    case 'Read': case 'Write': case 'Edit': return input.file_path ?? input.path;
    case 'Glob': case 'Grep': return input.pattern;
    case 'Bash': { const c = input.command; return c ? c.slice(0, 30) + (c.length > 30 ? '...' : '') : undefined; }
  }
}

// -- Git (PERF: 3s file-based cache) --
const GIT_CACHE_PATH = '/tmp/claude-git-cache.json';
const GIT_CACHE_TTL = 3000;

function getGitStatusCached(cwd) {
  if (!cwd) return null;
  try {
    if (fs.existsSync(GIT_CACHE_PATH)) {
      const c = JSON.parse(fs.readFileSync(GIT_CACHE_PATH, 'utf8'));
      if (c.cwd === cwd && Date.now() - c.ts < GIT_CACHE_TTL) return c.data;
    }
  } catch { /* stale */ }

  const data = getGitStatusSync(cwd);
  try { fs.writeFileSync(GIT_CACHE_PATH, JSON.stringify({ cwd, ts: Date.now(), data }), 'utf8'); } catch { /* ok */ }
  return data;
}

function getGitStatusSync(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 800, encoding: 'utf8' }).trim();
    if (!branch) return null;

    let isDirty = false, fileStats;
    try {
      const st = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd, timeout: 800, encoding: 'utf8' }).trim();
      isDirty = st.length > 0;
      if (isDirty) {
        const stats = { modified: 0, added: 0, deleted: 0, untracked: 0 };
        for (const line of st.split('\n').filter(Boolean)) {
          if (line.startsWith('??')) stats.untracked++;
          else if (line[0] === 'A') stats.added++;
          else if (line[0] === 'D' || line[1] === 'D') stats.deleted++;
          else if ('MRC'.includes(line[0]) || line[1] === 'M') stats.modified++;
        }
        fileStats = stats;
      }
    } catch { /* clean */ }

    let ahead = 0, behind = 0;
    try {
      const r = execFileSync('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd, timeout: 800, encoding: 'utf8' }).trim();
      const [b, a] = r.split(/\s+/);
      behind = parseInt(b, 10) || 0; ahead = parseInt(a, 10) || 0;
    } catch { /* no upstream */ }

    return { branch, isDirty, ahead, behind, fileStats };
  } catch { return null; }
}

// -- Config Counts (PERF: sync, fast fs reads) --
function countRulesInDir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countRulesInDir(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.md')) n++;
    }
  } catch { /* ok */ }
  return n;
}
function getMcpNames(fp) {
  if (!fs.existsSync(fp)) return new Set();
  try { const c = JSON.parse(fs.readFileSync(fp, 'utf8')); return c.mcpServers ? new Set(Object.keys(c.mcpServers)) : new Set(); } catch { return new Set(); }
}
function countHooks(fp) {
  if (!fs.existsSync(fp)) return 0;
  try { const c = JSON.parse(fs.readFileSync(fp, 'utf8')); return c.hooks ? Object.keys(c.hooks).length : 0; } catch { return 0; }
}

function countConfigs(cwd) {
  const cd = path.join(HOME, '.claude');
  let claudeMdCount = 0, rulesCount = 0, hooksCount = 0;
  if (fs.existsSync(path.join(cd, 'CLAUDE.md'))) claudeMdCount++;
  rulesCount += countRulesInDir(path.join(cd, 'rules'));
  const userMcp = new Set([...getMcpNames(path.join(cd, 'settings.json')), ...getMcpNames(path.join(HOME, '.claude.json'))]);
  hooksCount += countHooks(path.join(cd, 'settings.json'));
  try { const c = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')); if (Array.isArray(c.disabledMcpServers)) c.disabledMcpServers.forEach(n => userMcp.delete(n)); } catch { /* ok */ }

  const projectMcp = new Set();
  if (cwd) {
    for (const p of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/CLAUDE.local.md'])
      if (fs.existsSync(path.join(cwd, p))) claudeMdCount++;
    rulesCount += countRulesInDir(path.join(cwd, '.claude', 'rules'));
    for (const p of ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'])
      for (const n of getMcpNames(path.join(cwd, p))) projectMcp.add(n);
    hooksCount += countHooks(path.join(cwd, '.claude', 'settings.json'));
    hooksCount += countHooks(path.join(cwd, '.claude', 'settings.local.json'));
  }
  return { claudeMdCount, rulesCount, mcpCount: userMcp.size + projectMcp.size, hooksCount, mcpNames: [...userMcp, ...projectMcp] };
}

// -- Usage API (PERF: 60s file cache, 15s failure cache) --
function readUsageCache(now) {
  try {
    if (!fs.existsSync(USAGE_CACHE_PATH)) return null;
    const c = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8'));
    if (now - c.timestamp >= (c.data.apiUnavailable ? 15000 : 60000)) return null;
    if (c.data.fiveHourResetAt) c.data.fiveHourResetAt = new Date(c.data.fiveHourResetAt);
    if (c.data.sevenDayResetAt) c.data.sevenDayResetAt = new Date(c.data.sevenDayResetAt);
    return c.data;
  } catch { return null; }
}
function writeUsageCache(data, ts) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify({ data, timestamp: ts }), 'utf8');
  } catch { /* ok */ }
}

function readCredentials(now) {
  // Keychain backoff check
  try {
    if (fs.existsSync(KEYCHAIN_BACKOFF_PATH)) {
      const ts = parseInt(fs.readFileSync(KEYCHAIN_BACKOFF_PATH, 'utf8'), 10);
      if (now - ts < 60000) return readFileCreds(now);
    }
  } catch { /* ok */ }

  // macOS Keychain
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (raw) {
        const d = JSON.parse(raw);
        const tok = d.claudeAiOauth?.accessToken;
        if (tok && (d.claudeAiOauth?.expiresAt == null || d.claudeAiOauth.expiresAt > now)) {
          const sub = d.claudeAiOauth?.subscriptionType ?? '';
          if (sub) return { accessToken: tok, subscriptionType: sub };
          const fc = readFileCreds(now);
          return { accessToken: tok, subscriptionType: fc?.subscriptionType ?? '' };
        }
      }
    } catch {
      try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(KEYCHAIN_BACKOFF_PATH, String(now), 'utf8');
      } catch { /* ok */ }
    }
  }
  return readFileCreds(now);
}

function readFileCreds(now) {
  const fp = path.join(HOME, '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(fp)) return null;
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const tok = d.claudeAiOauth?.accessToken;
    if (!tok || (d.claudeAiOauth?.expiresAt != null && d.claudeAiOauth.expiresAt <= now)) return null;
    return { accessToken: tok, subscriptionType: d.claudeAiOauth?.subscriptionType ?? '' };
  } catch { return null; }
}

function getPlanName(sub) {
  const l = (sub || '').toLowerCase();
  if (l.includes('max')) return 'Max';
  if (l.includes('pro')) return 'Pro';
  if (l.includes('team')) return 'Team';
  if (!sub || l.includes('api')) return null;
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

function fetchUsageApi(token) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-statusline/1.0' },
      timeout: 5000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { res.statusCode === 200 ? (() => { try { resolve(JSON.parse(d)); } catch { resolve(null); } })() : resolve(null); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getUsage() {
  const now = Date.now();
  const cached = readUsageCache(now);
  if (cached) return cached;
  try {
    const creds = readCredentials(now);
    if (!creds) return null;
    const planName = getPlanName(creds.subscriptionType);
    if (!planName) return null;
    const api = await fetchUsageApi(creds.accessToken);
    if (!api) { const f = { planName, fiveHour: null, sevenDay: null, fiveHourResetAt: null, sevenDayResetAt: null, apiUnavailable: true }; writeUsageCache(f, now); return f; }
    const clamp = v => v == null || !Number.isFinite(v) ? null : Math.round(Math.max(0, Math.min(100, v)));
    const parseD = s => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; };
    const r = { planName, fiveHour: clamp(api.five_hour?.utilization), sevenDay: clamp(api.seven_day?.utilization), fiveHourResetAt: parseD(api.five_hour?.resets_at), sevenDayResetAt: parseD(api.seven_day?.resets_at) };
    writeUsageCache(r, now);
    return r;
  } catch { return null; }
}

// -- Render --
function fmtDuration(start) {
  if (!start) return '';
  const m = Math.floor((Date.now() - start.getTime()) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtReset(d) {
  if (!d) return '';
  const m = Math.ceil((d.getTime() - Date.now()) / 60000);
  if (m <= 0) return '';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`;
}
function fmtUsagePct(p) { return p === null ? dim('--') : `${ctxColor(p)}${p}%${RST}`; }

function renderIdentity(stdin, usage, dur) {
  const model = getModelName(stdin);
  const pct = getContextPercent(stdin);
  const parts = [];
  const plan = usage?.planName;
  parts.push(`${cyan(`[${plan ? `${model} | ${plan}` : model}]`)} ${coloredBar(pct)} ${ctxColor(pct)}${pct}%${RST}`);

  if (usage?.planName && !usage.apiUnavailable) {
    const isLimit = usage.fiveHour === 100 || usage.sevenDay === 100;
    if (isLimit) {
      const rt = fmtReset(usage.fiveHour === 100 ? usage.fiveHourResetAt : usage.sevenDayResetAt);
      parts.push(red(`\u26a0 Limit${rt ? ` (${rt})` : ''}`));
    }
  } else if (usage?.apiUnavailable) parts.push(yellow('\u26a0'));

  if (dur) parts.push(dim(`\u23f1\ufe0f  ${dur}`));
  let line = parts.join(' | ');
  if (pct >= 85) {
    const u = stdin.context_window?.current_usage;
    if (u) line += dim(` (in: ${fmtTokens(u.input_tokens ?? 0)}, cache: ${fmtTokens((u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0))})`);
  }
  return line;
}

function renderProject(stdin, git) {
  if (!stdin.cwd) return null;
  const segs = stdin.cwd.split(/[/\\]/).filter(Boolean);
  const proj = segs.length > 0 ? segs.slice(-2).join('/') : '/';
  let gp = '';
  if (git) {
    const parts = [git.branch];
    if (git.isDirty) parts.push('*');
    if (git.ahead > 0) parts.push(` \u2191${git.ahead}`);
    if (git.behind > 0) parts.push(` \u2193${git.behind}`);
    if (git.fileStats) {
      const { modified: m, added: a, deleted: d, untracked: u } = git.fileStats;
      const s = []; if (m) s.push(`!${m}`); if (a) s.push(`+${a}`); if (d) s.push(`\u2718${d}`); if (u) s.push(`?${u}`);
      if (s.length) parts.push(` ${s.join(' ')}`);
    }
    gp = ` ${magenta('git:(')}${cyan(parts.join(''))}${magenta(')')}`;
  }
  return `${yellow(proj)}${gp}`;
}

function renderEnv(cfg) {
  const p = [];
  if (cfg.claudeMdCount) p.push(`${cfg.claudeMdCount} CLAUDE.md`);
  if (cfg.rulesCount) p.push(`${cfg.rulesCount} rules`);
  if (cfg.mcpCount) p.push(`${cfg.mcpCount} MCPs`);
  if (cfg.hooksCount) p.push(`${cfg.hooksCount} hooks`);
  return p.length ? dim(p.join(' | ')) : null;
}

function renderTools(tr) {
  if (!tr.tools.length) return null;
  const p = [];
  for (const t of tr.tools.filter(t => t.status === 'running').slice(-2)) {
    const tgt = t.target ? dim(`: ${t.target.length > 20 ? '.../' + (t.target.split('/').pop() || t.target) : t.target}`) : '';
    p.push(`${yellow('\u25d0')} ${cyan(t.name)}${tgt}`);
  }
  const counts = new Map();
  for (const t of tr.tools.filter(t => t.status !== 'running')) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  for (const [n, c] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4))
    p.push(`${green('\u2713')} ${n} ${dim(`\u00d7${c}`)}`);
  return p.length ? p.join(' | ') : null;
}

function renderAgents(tr) {
  const show = [...tr.agents.filter(a => a.status === 'running'), ...tr.agents.filter(a => a.status === 'completed').slice(-2)].slice(-3);
  if (!show.length) return null;
  return show.map(a => {
    const icon = a.status === 'running' ? yellow('\u25d0') : green('\u2713');
    const ms = ((a.endTime ?? new Date()).getTime()) - a.startTime.getTime();
    const el = ms < 1000 ? '<1s' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    return `${icon} ${magenta(a.type)}${a.model ? ` ${dim(`[${a.model}]`)}` : ''}${a.description ? dim(`: ${a.description.slice(0, 40)}`) : ''} ${dim(`(${el})`)}`;
  }).join('\n');
}

function renderTodos(tr) {
  if (!tr.todos.length) return null;
  const done = tr.todos.filter(t => t.status === 'completed').length;
  const total = tr.todos.length;
  const ip = tr.todos.find(t => t.status === 'in_progress');
  if (!ip) return done === total && total > 0 ? `${green('\u2713')} All todos complete ${dim(`(${done}/${total})`)}` : null;
  return `${yellow('\u25b8')} ${(ip.content ?? ip.subject ?? '').slice(0, 50)} ${dim(`(${done}/${total})`)}`;
}

// -- Main --
async function main() {
  try {
    const stdin = await readStdin();
    if (!stdin) { console.log('[statusline] Initializing...'); return; }

    const cwd = stdin.cwd;
    const transcriptPath = stdin.transcript_path ?? '';

    // PERF: transcript + git are cached; usage has 60s cache; configs are fast sync reads
    const transcript = parseTranscript(transcriptPath);   // sync, incremental
    const gitStatus = getGitStatusCached(cwd);            // sync, 3s cache
    const configs = countConfigs(cwd);                    // sync, fast
    const usage = await getUsage();                       // async, 60s cache

    const dur = fmtDuration(transcript.sessionStart);

    // Render
    const lines = [];
    const id = renderIdentity(stdin, usage, dur); if (id) lines.push(id);
    const pr = renderProject(stdin, gitStatus);   if (pr) lines.push(pr);
    const en = renderEnv(configs);                if (en) lines.push(en);
    const tl = renderTools(transcript);           if (tl) lines.push(tl);
    const ag = renderAgents(transcript);          if (ag) lines.push(ag);
    const td = renderTodos(transcript);           if (td) lines.push(td);

    if (!process.env.CLAUDE_STATUSLINE_QUIET) {
      for (const l of lines) console.log(`${RST}${l}`);
    }

    // Save enriched state for tmux panel (async, non-blocking)
    const panel = {
      ...stdin,
      _panel: {
        tools: transcript.tools.map(t => ({ name: t.name, status: t.status, target: t.target })),
        agents: transcript.agents.map(a => ({ type: a.type, model: a.model, description: a.description, status: a.status, startTime: a.startTime, endTime: a.endTime })),
        todos: transcript.todos,
        sessionStart: transcript.sessionStart,
        gitStatus, configs, usage, duration: dur,
        contextPercent: getContextPercent(stdin),
      },
    };
    fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(panel), () => {
      try { fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch { /* ok */ }
    });
  } catch (err) {
    console.log(`[statusline] ${err?.message ?? 'Error'}`);
  }
}

main();
