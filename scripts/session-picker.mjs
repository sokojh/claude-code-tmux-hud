#!/usr/bin/env node
// Claude Code Session Picker — interactive TUI for resuming sessions
// Zero npm dependencies. Node.js 18+ required.
// TUI renders to stderr, selected sessionId prints to stdout.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CACHE_DIR = path.join(HOME, '.claude', '.tmux-hud-cache');
const SESSION_CACHE_PATH = path.join(CACHE_DIR, 'session-index-cache.json');
const SESSION_CACHE_TTL = 30000;

// ── Colors ──────────────────────────────────────────────────
const RST = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const MAG = '\x1b[35m';
const CYN = '\x1b[36m';
const WHT = '\x1b[37m';
const GRAY = '\x1b[90m';
const BG_GRAY = '\x1b[48;5;236m';
const B_CYN = '\x1b[96m';

// ── Session Cache ───────────────────────────────────────────
function loadSessionCache() {
  try {
    if (!fs.existsSync(SESSION_CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(SESSION_CACHE_PATH, 'utf8'));
    if (Date.now() - raw.timestamp < SESSION_CACHE_TTL) return raw.sessions;
  } catch { /* stale */ }
  return null;
}

function saveSessionCache(sessions) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SESSION_CACHE_PATH, JSON.stringify({ sessions, timestamp: Date.now() }), 'utf8');
  } catch { /* ok */ }
}

// ── Project Name Resolution ─────────────────────────────────
function projectNameFromPath(cwdPath) {
  if (!cwdPath) return '?';
  if (cwdPath === HOME || cwdPath === HOME + '/') return '~';

  let rel = cwdPath;
  if (cwdPath.startsWith(HOME + '/')) rel = cwdPath.slice(HOME.length + 1);
  else if (cwdPath.startsWith('/')) rel = cwdPath;

  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return '~';

  const last = parts[parts.length - 1];
  // If last is a generic subdir, use parent instead
  const generic = new Set(['src', 'app', 'lib', 'cmd', 'internal', 'pkg', 'server', 'worker', 'client', 'web']);
  if (generic.has(last.toLowerCase()) && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return last;
}

// ── Worktree Detection ──────────────────────────────────────
function detectWorktree(projectPath) {
  if (!projectPath) return null;
  const marker = '/.claude/worktrees/';
  const idx = projectPath.indexOf(marker);
  if (idx >= 0) {
    const rest = projectPath.slice(idx + marker.length);
    const name = rest.split('/')[0];
    return name || null;
  }
  return null;
}

// ── Clean Description ───────────────────────────────────────
function cleanDescription(text) {
  if (!text) return null;
  let c = text
    .replace(/<local-command-caveat>[^]*?(<\/local-command-caveat>|$)/g, '')
    .replace(/<system-reminder>[^]*?(<\/system-reminder>|$)/g, '')
    .replace(/<teammate-message[^]*?(<\/teammate-message>|$)/g, '')
    .replace(/<[a-z][a-z0-9-]*>[^<]*$/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  c = c.replace(/^[)\s,.:;⏺`]+/, '').trim();
  // Filter out useless content
  if (c.startsWith('Caveat:') || c.startsWith('```')) return null;
  if (/^[0-9a-f-]{8,}$/i.test(c)) return null;
  if (c.startsWith('[Request interrupted')) return null;
  // Strip common prefixes that add no info
  c = c.replace(/^Implement the following plan:\s*#?\s*/i, '');
  c = c.replace(/^This session is being continued from a previous[^]*?(?:\n\n|\. )/s, '');
  c = c.replace(/^#\s+/, '');
  if (c.length < 3) return null;
  // Collapse whitespace
  c = c.replace(/\s+/g, ' ');
  return c.slice(0, 120);
}

// ── Session Scanner (history.jsonl based, like agf) ─────────
const HISTORY_PATH = path.join(HOME, '.claude', 'history.jsonl');

function scanSessions() {
  const cached = loadSessionCache();
  if (cached) return cached;

  // Primary: read history.jsonl (compact index of all user interactions)
  const sessions = scanFromHistory();

  sessions.sort((a, b) => b.modified - a.modified);
  saveSessionCache(sessions);
  return sessions;
}

function scanFromHistory() {
  let content;
  try { content = fs.readFileSync(HISTORY_PATH, 'utf8'); }
  catch { return []; }

  // Group entries by sessionId
  const sessMap = new Map();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.sessionId) continue;

      let s = sessMap.get(e.sessionId);
      if (!s) {
        s = {
          sessionId: e.sessionId,
          projectPath: e.project || '',
          displays: [],
          modified: e.timestamp || 0,
        };
        sessMap.set(e.sessionId, s);
      }

      if (e.timestamp && e.timestamp > s.modified) s.modified = e.timestamp;
      if (e.display) s.displays.push(e.display);
    } catch { /* skip */ }
  }

  // Build sessionId → filePath map for git branch lookup
  const fileMap = buildSessionFileMap();

  const sessions = [];
  for (const s of sessMap.values()) {
    // Pick best description: first non-command display entry
    const desc = pickDescription(s.displays);

    // Resolve git branch from session file header (fast: only first 4KB)
    const gitBranch = fileMap.has(s.sessionId)
      ? readGitBranch(fileMap.get(s.sessionId))
      : null;

    sessions.push({
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      summary: null,
      firstPrompt: cleanDescription(desc),
      displays: s.displays,  // all user messages for preview
      messageCount: s.displays.length,
      modified: s.modified,
      gitBranch,
      projectName: projectNameFromPath(s.projectPath),
      worktreeName: detectWorktree(s.projectPath),
    });
  }

  return sessions;
}

// Pick the most recent meaningful display text for description
function pickDescription(displays) {
  if (!displays || displays.length === 0) return null;
  // Search from the end (most recent first)
  for (let i = displays.length - 1; i >= 0; i--) {
    const d = displays[i];
    if (!d || d.length < 4) continue;
    if (d.startsWith('/') && !d.includes(' ')) continue; // slash command
    return d;
  }
  return displays[displays.length - 1] || null;
}

// Build sessionId → filePath map by scanning project dirs
function buildSessionFileMap() {
  const map = new Map();
  if (!fs.existsSync(PROJECTS_DIR)) return map;

  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const dirName of dirs) {
      const dirPath = path.join(PROJECTS_DIR, dirName);
      try {
        for (const f of fs.readdirSync(dirPath)) {
          if (f.endsWith('.jsonl')) {
            map.set(f.replace('.jsonl', ''), path.join(dirPath, f));
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* ok */ }
  return map;
}

// Read just git branch from session file header (first 4KB)
function readGitBranch(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const buf = Buffer.alloc(Math.min(stat.size, 4096));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.gitBranch && d.gitBranch !== 'HEAD') return d.gitBranch;
      } catch { break; }
    }
  } catch { /* ok */ }
  return null;
}

// ── Fuzzy Matcher ───────────────────────────────────────────
function fuzzyMatch(query, text) {
  if (!query || !text) return { match: !query, score: 0, positions: [] };
  const lq = query.toLowerCase(), lt = text.toLowerCase();
  let qi = 0, score = 0, lastIdx = -2;
  const positions = [];
  for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
    if (lt[ti] === lq[qi]) {
      if (ti === lastIdx + 1) score += 3;
      if (ti === 0 || /[\s\-_/.]/.test(lt[ti - 1])) score += 5;
      if (text[ti] === query[qi]) score += 1;
      positions.push(ti);
      lastIdx = ti; qi++;
    }
  }
  if (qi < lq.length) return { match: false, score: 0, positions: [] };
  score += Math.max(0, 50 - text.length);
  return { match: true, score, positions };
}

function matchEntry(query, s) {
  if (!query) return { match: true, score: 0 };
  let best = -1;
  for (const f of [s.summary, s.firstPrompt, s.projectName, s.gitBranch, s.worktreeName]) {
    if (!f) continue;
    const r = fuzzyMatch(query, f);
    if (r.match && r.score > best) best = r.score;
  }
  return { match: best >= 0, score: best };
}

// ── Time Formatting (agf style: "2m · 02/17") ──────────────
function fmtTime(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  let rel;
  if (mins < 1) rel = 'now';
  else if (mins < 60) rel = `${mins}m`;
  else if (mins < 1440) rel = `${Math.floor(mins / 60)}h`;
  else if (mins < 10080) rel = `${Math.floor(mins / 1440)}d`;
  else if (mins < 43800) rel = `${Math.floor(mins / 10080)}w`;
  else rel = `${Math.floor(mins / 43800)}mo`;

  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return { rel, date: `${mm}/${dd}` };
}

// ── String Utilities (CJK-aware) ────────────────────────────
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// Character display width: CJK fullwidth = 2, others = 1, control = 0
function charW(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // CJK ranges (East Asian Width: W/F)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals, Kangxi, CJK Symbols
    (cp >= 0x3040 && cp <= 0x33bf) ||   // Hiragana, Katakana, Bopomofo, CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Unified Ext A
    (cp >= 0x4e00 && cp <= 0xa4cf) ||   // CJK Unified, Yi
    (cp >= 0xa960 && cp <= 0xa97c) ||   // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
    (cp >= 0xd7b0 && cp <= 0xd7fb) ||   // Hangul Jamo Extended-B
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK Compat Forms
    (cp >= 0xff01 && cp <= 0xff60) ||   // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth Signs
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Unified Ext B-F
    (cp >= 0x30000 && cp <= 0x3fffd)    // CJK Unified Ext G+
  ) return 2;
  return 1;
}

// Display width of a plain (no ANSI) string
function strW(s) {
  let w = 0;
  for (const ch of s) w += charW(ch.codePointAt(0));
  return w;
}

// Display width of a string that may contain ANSI codes
function visLen(s) { return strW(stripAnsi(s)); }

// Truncate plain string to fit within maxW display columns
function truncS(s, maxW) {
  if (maxW <= 0) return '';
  // Normalize: collapse newlines/tabs to space
  const clean = s.replace(/[\r\n\t]+/g, ' ');
  let w = 0;
  let i = 0;
  for (const ch of clean) {
    const cw = charW(ch.codePointAt(0));
    if (w + cw > maxW) break;
    w += cw;
    i += ch.length;
  }
  if (i >= clean.length) return clean;
  // Need truncation — recalculate to leave room for ".."
  if (maxW <= 2) return '.'.repeat(maxW);
  let tw = 0, ti = 0;
  for (const ch of clean) {
    const cw = charW(ch.codePointAt(0));
    if (tw + cw > maxW - 2) break;
    tw += cw;
    ti += ch.length;
  }
  return clean.slice(0, ti) + '..';
}

// Right-pad with spaces to fill exactly w display columns
function padR(s, w) {
  const vl = visLen(s);
  return vl < w ? s + ' '.repeat(w - vl) : s;
}

// Render text with fuzzy match highlights, CJK-aware truncation
function renderHighlight(text, maxW, positions, baseColor, hlColor) {
  if (!text || maxW <= 0) return '';
  const clean = text.replace(/[\r\n\t]+/g, ' ');
  const posSet = new Set(positions || []);

  if (!posSet.size) return `${baseColor}${truncS(clean, maxW)}${RST}`;

  const totalW = strW(clean);
  const needsTrunc = totalW > maxW;
  const limit = needsTrunc ? (maxW <= 2 ? 0 : maxW - 2) : maxW;
  if (limit <= 0) return maxW > 0 ? '.'.repeat(maxW) : '';

  let w = 0, out = baseColor, inHl = false, ci = 0;
  for (const ch of clean) {
    const cw = charW(ch.codePointAt(0));
    if (w + cw > limit) break;
    const hl = posSet.has(ci);
    if (hl && !inHl) { out += hlColor; inHl = true; }
    else if (!hl && inHl) { out += RST + baseColor; inHl = false; }
    out += ch;
    w += cw; ci++;
  }
  if (inHl) out += RST + baseColor;
  if (needsTrunc) out += '..';
  out += RST;
  return out;
}

// ── TUI ─────────────────────────────────────────────────────
class SessionPicker {
  constructor(sessions, initialQuery) {
    this.all = sessions;
    this.query = initialQuery || '';
    this.cursor = 0;
    this.scroll = 0;
    this.filtered = [];
    this.cols = process.stderr.columns || 120;
    this.rows = process.stderr.rows || 30;
    this.applyFilter();
  }

  applyFilter() {
    if (!this.query) {
      this.filtered = [...this.all];
    } else {
      this.filtered = [];
      for (const s of this.all) {
        const r = matchEntry(this.query, s);
        if (r.match) this.filtered.push({ ...s, _score: r.score });
      }
      this.filtered.sort((a, b) => (b._score || 0) - (a._score || 0));
    }
    if (this.cursor >= this.filtered.length) this.cursor = Math.max(0, this.filtered.length - 1);
    this.fixScroll();
  }

  get previewH() { return Math.min(6, Math.max(3, Math.floor(this.rows * 0.2))); }
  get listH() { return Math.max(3, this.rows - 5 - this.previewH - 1); }  // search(2) + status(2) + preview + divider(1)

  fixScroll() {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + this.listH) this.scroll = this.cursor - this.listH + 1;
  }

  render() {
    const w = this.cols;
    const out = [];

    // ── Search bar (line 1) — always visible at top ──
    const labelText = this.query ? `${this.filtered.length}/${this.all.length}` : 'All';
    const label = `${DIM}[${labelText}]${RST}`;
    const labelW = strW(labelText) + 2; // brackets
    if (this.query) {
      const qW = strW(this.query);
      const searchW = 4 + qW + 1; // "  > " + query + "_"
      const gap = Math.max(1, w - searchW - labelW - 1);
      out.push(`  ${CYN}>${RST} ${this.query}${DIM}_${RST}${' '.repeat(gap)}${label}`);
    } else {
      const gap = Math.max(1, w - 22 - labelW - 1);
      out.push(`  ${DIM}> type to search...${RST}${' '.repeat(gap)}${label}`);
    }
    out.push('');

    // ── Session list ──
    if (this.filtered.length === 0) {
      out.push(`  ${DIM}No sessions found${RST}`);
    } else {
      const visible = this.filtered.slice(this.scroll, this.scroll + this.listH);
      for (let i = 0; i < visible.length; i++) {
        out.push(this.renderRow(visible[i], this.scroll + i === this.cursor, w));
      }
    }

    // ── Pad remaining lines ──
    const renderedListLines = Math.min(this.filtered.length, this.listH);
    const emptyLines = this.listH - renderedListLines;
    for (let i = 0; i < emptyLines; i++) out.push('');

    // ── Preview: recent messages for selected session ──
    out.push(`  ${DIM}${'─'.repeat(Math.max(1, w - 3))}${RST}`);
    const cur = this.filtered[this.cursor];
    const previewLines = this.renderPreview(cur, w, this.previewH);
    for (const pl of previewLines) out.push(pl);
    // pad if preview is shorter
    for (let i = previewLines.length; i < this.previewH; i++) out.push('');

    // ── Status bar (bottom) ──
    const posText = this.filtered.length > 0 ? `${this.cursor + 1} of ${this.filtered.length} sessions` : 'no sessions';
    const keysText = '\u2191\u2193 nav  enter select  esc quit';
    const leftW = 2 + strW(posText);
    const rightW = strW(keysText);
    const gap = Math.max(1, w - leftW - rightW - 2);
    out.push(`  ${DIM}${posText}${RST}${' '.repeat(gap)}${DIM}${keysText}${RST}`);

    return out.join('\n');
  }

  renderRow(s, isCur, w) {
    const usable = w - 1;
    const ptr = isCur ? `${B_CYN}> ${RST}` : '  ';
    const ptrW = 2;

    const { rel, date } = fmtTime(s.modified);
    const msgTag = s.messageCount > 0 ? `${s.messageCount}msg` : '';
    const timePlain = msgTag
      ? `${msgTag}  ${rel.padStart(3)} \u00b7 ${date}`
      : `${rel.padStart(3)} \u00b7 ${date}`;
    const timeW = strW(timePlain);

    // Branch or worktree
    const branchMax = 18;
    let branchLabel = '';
    let branchColor = GRN;
    if (s.worktreeName) {
      branchLabel = 'wt:' + truncS(s.worktreeName, branchMax - 3);
      branchColor = CYN;
    } else if (s.gitBranch) {
      branchLabel = truncS(s.gitBranch, branchMax);
    }
    const branchW = branchLabel ? strW(branchLabel) + 2 : 0;

    const projMax = Math.min(20, Math.floor(usable * 0.16));
    const projText = s.projectName || '~';

    const fixedW = ptrW + projMax + 1 + 2 + branchW + timeW;
    const descAvail = Math.max(8, usable - fixedW);
    const descText = s.summary || s.firstPrompt || '';

    // Fuzzy match positions for highlighting
    const q = this.query;
    const HL = `${YLW}${BOLD}`;
    const projPos = q ? fuzzyMatch(q, projText).positions : [];
    const descPos = q ? fuzzyMatch(q, descText).positions : [];
    const brPos = q && branchLabel ? fuzzyMatch(q, branchLabel).positions : [];

    // Project name
    const projFmt = projPos.length > 0
      ? padR(renderHighlight(projText, projMax, projPos, isCur ? WHT + BOLD : YLW, HL), projMax)
      : isCur
        ? padR(`${WHT}${BOLD}${truncS(projText, projMax)}${RST}`, projMax)
        : padR(`${YLW}${truncS(projText, projMax)}${RST}`, projMax);

    // Description
    const descFmt = descPos.length > 0
      ? padR(renderHighlight(descText, descAvail, descPos, isCur ? WHT : DIM, HL), descAvail)
      : isCur
        ? padR(`${WHT}${truncS(descText, descAvail)}${RST}`, descAvail)
        : padR(`${DIM}${truncS(descText, descAvail)}${RST}`, descAvail);

    // Branch / worktree
    let branchFmt = '';
    if (branchLabel) {
      branchFmt = brPos.length > 0
        ? renderHighlight(branchLabel, branchMax, brPos, branchColor, HL) + '  '
        : `${branchColor}${branchLabel}${RST}  `;
    }

    const timeFmt = `${DIM}${timePlain}${RST}`;
    return `${ptr}${projFmt} ${descFmt}  ${branchFmt}${timeFmt}`;
  }

  renderPreview(s, w, maxLines) {
    if (!s || !s.displays || s.displays.length === 0) {
      return [`  ${DIM}(no messages)${RST}`];
    }
    const usable = w - 5; // "  > " prefix + margin
    // Show last N messages (most recent conversation)
    const msgs = s.displays.slice(-maxLines);
    const lines = [];
    for (let i = 0; i < msgs.length && lines.length < maxLines; i++) {
      const raw = (msgs[i] || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      const text = truncS(raw, usable);
      if (i === msgs.length - 1) {
        // Latest message highlighted
        lines.push(`  ${CYN}>${RST} ${WHT}${text}${RST}`);
      } else {
        lines.push(`    ${DIM}${text}${RST}`);
      }
    }
    return lines.length > 0 ? lines : [`  ${DIM}(no messages)${RST}`];
  }

  // ── Interaction ───────────────────────────────────────────
  async run() {
    process.stderr.write('\x1b[?1049h\x1b[?25l');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const rTarget = process.stderr.isTTY ? process.stderr : process.stdout;
    rTarget.on('resize', () => {
      this.cols = process.stderr.columns || process.stdout.columns || 120;
      this.rows = process.stderr.rows || process.stdout.rows || 30;
      this.draw();
    });

    this.draw();

    return new Promise((resolve) => {
      process.stdin.on('data', (key) => {
        if (key === '\x03') { this.exit(); resolve(null); return; }

        if (key.startsWith('\x1b[') || key.startsWith('\x1bO')) {
          if (key === '\x1b[A') { this.move(-1); return; }
          if (key === '\x1b[B') { this.move(1); return; }
          if (key === '\x1b[5~') { this.move(-this.listH); return; }
          if (key === '\x1b[6~') { this.move(this.listH); return; }
          if (key === '\x1b[H' || key === '\x1b[1~') { this.cursor = 0; this.fixScroll(); this.draw(); return; }
          if (key === '\x1b[F' || key === '\x1b[4~') { this.cursor = Math.max(0, this.filtered.length - 1); this.fixScroll(); this.draw(); return; }
          return;
        }
        if (key === '\x1b') { this.exit(); resolve(null); return; }

        if (key === '\r' || key === '\n') {
          if (this.filtered.length > 0) {
            const sel = this.filtered[this.cursor];
            this.exit();
            resolve(sel);
          }
          return;
        }

        if (key === '\x7f' || key === '\b') {
          if (this.query.length > 0) { this.query = this.query.slice(0, -1); this.applyFilter(); this.draw(); }
          return;
        }
        if (key === '\x15') { this.query = ''; this.applyFilter(); this.draw(); return; }
        if (key === '\t') return;

        if (key.length >= 1 && key.charCodeAt(0) >= 32 && !key.startsWith('\x1b')) {
          this.query += key;
          this.applyFilter();
          this.draw();
        }
      });
    });
  }

  move(d) {
    this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor + d));
    this.fixScroll();
    this.draw();
  }

  draw() {
    // Disable line wrap, clear, move to top-left
    process.stderr.write('\x1b[?7l\x1b[2J\x1b[H');
    process.stderr.write(this.render());
    // Re-enable line wrap
    process.stderr.write('\x1b[?7h');
  }

  exit() {
    process.stderr.write('\x1b[?7h\x1b[?25h\x1b[?1049l');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const initialQuery = process.argv[2] || '';
  const sessions = scanSessions();

  if (sessions.length === 0) {
    process.stderr.write(`${YLW}No sessions found${RST}\n`);
    process.exit(1);
  }

  const picker = new SessionPicker(sessions, initialQuery);
  const selected = await picker.run();

  if (selected) {
    // Output tab-separated: sessionId \t projectPath
    // Shell script parses both to cd + resume
    const projPath = selected.projectPath || HOME;
    process.stdout.write(`${selected.sessionId}\t${projPath}`);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
