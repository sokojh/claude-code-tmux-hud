# claude-code-tmux-hud

A real-time HUD (Head-Up Display) for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) inside tmux.

Launch Claude Code with a live side panel that shows context usage, quota, git status, active tools, agents, and more — all updating in real time.

```
+----------------------------------+----------+
| $ claude                          | HUD      |
|                                   |          |
| Claude Code session               | Session  |
| running here...                   | ██░ 45%  |
|                                   |          |
|                                   | Usage    |
|                                   | 5h ██ 12%|
|                                   | 7d █░ 8% |
|                                   |          |
|                                   | TODO     |
|                                   | > task.. |
|                                   |          |
|                                   | Repo     |
|                                   | main *   |
+----------------------------------+----------+
```

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/sokojh/claude-code-tmux-hud/main/install.sh | bash
```

Then restart your shell and run:

```bash
ct
```

## Features

- **Statusline**: Model, context window %, plan type — rendered in Claude Code's built-in status bar
- **Side Panel**: Real-time dashboard in a tmux pane showing:
  - Context window usage with color-coded progress bar
  - 5-hour / 7-day quota usage with reset timers
  - Active TODO items from Claude's task list
  - Git branch, dirty state, ahead/behind counts
  - Active MCP servers
  - Running tools and completed tool counts
  - Sub-agent status and elapsed time
- **Session Isolation**: Multiple `ct` sessions run independently with separate state files
- **Auto-cleanup**: Panel auto-exits when Claude Code exits

## Requirements

- **Node.js 18+** — statusline script uses Node.js built-in modules (zero dependencies)
- **tmux** — terminal multiplexer for the side panel layout
- **jq** — JSON processor for settings.json management and panel data parsing

### Install dependencies

```bash
# macOS
brew install node tmux jq

# Ubuntu/Debian
sudo apt-get install nodejs tmux jq

# Arch
sudo pacman -S nodejs tmux jq
```

## Usage

```bash
# Launch with auto-named session (claude-1, claude-2, ...)
ct

# Launch with a named session
ct work

# Named session with custom panel width
ct project 42

# Show help
ct --help

# Show version
ct --version

# Update to latest
ct --update
```

## How It Works

```
claude-tmux.sh (launcher)
├── tmux session with 2 panes
├── Left pane: claude (with CLAUDE_PANEL_ID env)
│   └── statusline.mjs (Claude Code statusLine)
│       ├── Reads stdin JSON from Claude Code
│       ├── Parses transcript incrementally
│       ├── Fetches usage API (cached 60s)
│       └── Writes state to /tmp/claude-panel-{id}.json
└── Right pane: tmux-panel.sh (dashboard)
    ├── Reads /tmp/claude-panel-{id}.json every 1s
    └── Renders colorful dashboard
```

### State Flow

1. Claude Code invokes `statusline.mjs` via its `statusLine` config (every ~300ms)
2. `statusline.mjs` receives session data on stdin, enriches it with git/usage/transcript data
3. Enriched state is written to a session-isolated temp file
4. `tmux-panel.sh` reads this file every second and renders the dashboard

## Customization

### Panel Width

Default is 38 columns. Adjust via the second argument:

```bash
ct work 50   # wider panel
ct work 30   # narrower panel
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PANEL_ID` | auto | Session identifier for state isolation |
| `CLAUDE_STATUSLINE_QUIET` | `1` (in ct) | Suppress statusline console output |

## File Locations

| File | Path | Purpose |
|------|------|---------|
| Scripts | `~/.claude/scripts/` | statusline.mjs, tmux-panel.sh, claude-tmux.sh |
| Cache | `~/.claude/.tmux-hud-cache/` | Usage API cache, keychain backoff |
| State | `/tmp/claude-panel-{id}.json` | Per-session state (auto-cleaned) |
| Settings | `~/.claude/settings.json` | statusLine command config |

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/sokojh/claude-code-tmux-hud/main/uninstall.sh | bash
```

Or manually:

```bash
# Remove scripts
rm -f ~/.claude/scripts/{statusline.mjs,tmux-panel.sh,claude-tmux.sh}

# Remove cache
rm -rf ~/.claude/.tmux-hud-cache

# Remove statusLine from settings.json
jq 'del(.statusLine)' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json

# Remove alias from shell rc
# Delete the "# Claude Code tmux HUD" and "alias ct=..." lines from ~/.zshrc or ~/.bashrc
```

## Compatibility

- **macOS** (primary): Tested with Homebrew Node.js, tmux, jq
- **Linux**: Cross-platform date parsing, GNU coreutils compatible

## License

MIT
