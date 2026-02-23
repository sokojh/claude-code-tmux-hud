#!/bin/bash
# Claude Code with tmux side panel dashboard
# Usage: ct [session-name] [panel-width]
#
# Session isolation: Each tmux session gets its own state file via CLAUDE_PANEL_ID
#
# Examples:
#   ct                           # Default session, 38-col panel
#   ct work 42                   # Named session, wider panel
#   ct query-gom                 # Named session for project

set -euo pipefail

VERSION="1.0.0"

case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Usage: ct [session-name] [panel-width]

Launch Claude Code in a tmux session with a real-time HUD side panel.

Arguments:
  session-name    Name for the tmux session (default: claude-N)
  panel-width     Width of the side panel in columns (default: 38)

Options:
  --help, -h      Show this help message
  --version       Show version number
  --update        Update to the latest version

Examples:
  ct                      # Auto-named session
  ct work                 # Named "work" session
  ct project 42           # Named session with wider panel
HELP
    exit 0
    ;;
  --version)
    echo "claude-code-tmux-hud v$VERSION"
    exit 0
    ;;
  --update)
    echo "Updating claude-code-tmux-hud..."
    curl -fsSL "https://raw.githubusercontent.com/sokojh/claude-code-tmux-hud/main/install.sh" | bash -s -- --update
    exit $?
    ;;
esac

PANEL_WIDTH="${2:-38}"

# Auto-generate unique session name if not provided
if [[ -n "${1:-}" ]]; then
  SESSION_NAME="$1"
else
  N=1
  while tmux has-session -t "claude-${N}" 2>/dev/null; do
    N=$((N + 1))
  done
  SESSION_NAME="claude-${N}"
fi

# Resolve script directory (works with symlinks)
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
PANEL_SCRIPT="$SCRIPT_DIR/tmux-panel.sh"

# Validate panel script exists
if [[ ! -x "$PANEL_SCRIPT" ]]; then
  echo "Error: Panel script not found or not executable: $PANEL_SCRIPT"
  echo "Run: chmod +x $PANEL_SCRIPT"
  exit 1
fi

# Clean up stale state for this session
rm -f "/tmp/claude-panel-${SESSION_NAME}.json" 2>/dev/null

# If session already exists, attach to it
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "Session '$SESSION_NAME' already exists. Attaching..."
  tmux attach -t "$SESSION_NAME"
  exit 0
fi

# Create new tmux session
tmux new-session -d -s "$SESSION_NAME" -x "$(tput cols)" -y "$(tput lines)"

# Set session-level env var for isolation
tmux set-environment -t "$SESSION_NAME" CLAUDE_PANEL_ID "$SESSION_NAME"

# Split: right pane for dashboard
tmux split-window -h -l "$PANEL_WIDTH" -t "$SESSION_NAME"

# Right pane (index 1): start dashboard with panel ID
tmux send-keys -t "$SESSION_NAME:0.1" "export CLAUDE_PANEL_ID='$SESSION_NAME' && $PANEL_SCRIPT" Enter

# Left pane (index 0): start claude with panel ID; kill session on exit
tmux send-keys -t "$SESSION_NAME:0.0" "export CLAUDE_PANEL_ID='$SESSION_NAME' CLAUDE_STATUSLINE_QUIET=1 && clear && claude; tmux kill-session -t '$SESSION_NAME' 2>/dev/null" Enter

# Focus left pane (Claude Code)
tmux select-pane -t "$SESSION_NAME:0.0"

# Attach
tmux attach -t "$SESSION_NAME"
