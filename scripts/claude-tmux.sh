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
REPO="sokojh/claude-code-tmux-hud"
UPDATE_CHECK_CACHE="$HOME/.claude/.tmux-hud-cache/update-check"
UPDATE_CHECK_INTERVAL=86400  # 24 hours

# Auto-update: check remote version and update if newer (cached 24h)
auto_update() {
  local cache_dir="$HOME/.claude/.tmux-hud-cache"
  mkdir -p "$cache_dir" 2>/dev/null || return

  # Skip if checked recently
  if [[ -f "$UPDATE_CHECK_CACHE" ]]; then
    local last_check now
    last_check=$(cat "$UPDATE_CHECK_CACHE" 2>/dev/null || echo "0")
    now=$(date +%s)
    if (( now - last_check < UPDATE_CHECK_INTERVAL )); then
      return
    fi
  fi

  # Fetch remote version (with short timeout to not block launch)
  local remote_ver
  remote_ver=$(curl -fsSL --connect-timeout 2 --max-time 4 \
    "https://raw.githubusercontent.com/$REPO/main/VERSION" 2>/dev/null | tr -d '[:space:]') || true

  # Record check timestamp
  date +%s > "$UPDATE_CHECK_CACHE" 2>/dev/null

  # Compare and auto-update if different
  if [[ -n "$remote_ver" && "$remote_ver" != "$VERSION" ]]; then
    printf '\033[33m[auto-update]\033[0m v%s -> v%s\n' "$VERSION" "$remote_ver"
    if curl -fsSL "https://raw.githubusercontent.com/$REPO/main/install.sh" | bash -s -- --update; then
      printf '\033[32m[ok]\033[0m Updated. Launching...\n'
      # Re-exec self with the updated script (pass original args through)
      exec "$0" "$@"
    else
      printf '\033[31m[warn]\033[0m Update failed, continuing with current version\n'
    fi
  fi
}

auto_update "$@"

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

# Enable mouse mode (scroll, pane select, resize)
tmux set-option -t "$SESSION_NAME" mouse on

# Set session-level env var for isolation
tmux set-environment -t "$SESSION_NAME" CLAUDE_PANEL_ID "$SESSION_NAME"

# Keybinding: Ctrl-b u → undo last change
UNDO_SCRIPT="$SCRIPT_DIR/undo.sh"
if [[ -x "$UNDO_SCRIPT" ]]; then
  tmux bind-key -T prefix u run-shell "$UNDO_SCRIPT"
fi

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
