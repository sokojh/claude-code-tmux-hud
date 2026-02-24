#!/bin/bash
# Claude Code with tmux side panel dashboard
# Usage: ct [session-name] [panel-width]
#        ct ls [query]       — Pick & resume a session via TUI
#        ct resume [query]   — Alias for ls
#        ct last [width]     — Continue most recent session
#
# Session isolation: Each tmux session gets its own state file via CLAUDE_PANEL_ID
#
# Examples:
#   ct                           # Default session, 38-col panel
#   ct work 42                   # Named session, wider panel
#   ct query-gom                 # Named session for project
#   ct ls                        # Open session picker TUI
#   ct ls databricks             # Picker with initial query
#   ct last                      # Resume most recent session

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

# Resolve script directory (works with symlinks)
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
PICKER_SCRIPT="$SCRIPT_DIR/session-picker.mjs"
RESUME_SESSION_ID=""
RESUME_PROJECT_PATH=""
CONTINUE_SESSION=""

case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Usage: ct [session-name] [panel-width]

Launch Claude Code in a tmux session with a real-time HUD side panel.

Arguments:
  session-name    Name for the tmux session (default: claude-N)
  panel-width     Width of the side panel in columns (default: 38)

Subcommands:
  ls [query]      Open session picker TUI, select to resume
  resume [query]  Alias for ls
  last [width]    Continue most recent session (claude --continue)

Options:
  --help, -h      Show this help message
  --version       Show version number
  --update        Update to the latest version

Examples:
  ct                      # Auto-named session
  ct work                 # Named "work" session
  ct project 42           # Named session with wider panel
  ct ls                   # Pick a session to resume
  ct ls databricks        # Pick with initial search query
  ct last                 # Continue most recent session
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
  ls|resume)
    # Session picker: launch TUI, capture "sessionId\tprojectPath"
    if [[ ! -f "$PICKER_SCRIPT" ]]; then
      echo "Error: session-picker.mjs not found at $PICKER_SCRIPT"
      exit 1
    fi
    PICKER_QUERY="${2:-}"
    PICKER_OUTPUT=$(node "$PICKER_SCRIPT" "$PICKER_QUERY") || {
      # User cancelled or no sessions
      exit 0
    }
    if [[ -z "$PICKER_OUTPUT" ]]; then
      exit 0
    fi
    # Parse tab-separated output: sessionId \t projectPath
    RESUME_SESSION_ID=$(echo "$PICKER_OUTPUT" | cut -f1)
    RESUME_PROJECT_PATH=$(echo "$PICKER_OUTPUT" | cut -f2)
    # Fall through to session creation with resume flag
    shift  # remove 'ls'/'resume'
    shift 2>/dev/null || true  # remove query if present
    ;;
  last)
    # Continue most recent session (ct last [width])
    CONTINUE_SESSION="true"
    shift  # remove 'last'
    ;;
  --resume-session)
    # Internal: called after picker selection (for recursive invocation)
    RESUME_SESSION_ID="${2:-}"
    shift 2
    ;;
  --continue-session)
    # Internal: continue most recent session
    CONTINUE_SESSION="true"
    shift
    ;;
esac

# Panel width: after subcommand shifts, check remaining positional args
# Normal: ct [name] [width] → $1=name, $2=width
# After subcommand shift: $1=width or empty
if [[ -n "$RESUME_SESSION_ID" || "$CONTINUE_SESSION" == "true" ]]; then
  PANEL_WIDTH="${1:-38}"
else
  PANEL_WIDTH="${2:-38}"
fi
[[ "$PANEL_WIDTH" =~ ^[0-9]+$ ]] || PANEL_WIDTH=38

# Auto-generate unique session name
if [[ -n "$RESUME_SESSION_ID" ]]; then
  # For resumed sessions, use a short identifier from the session ID
  SESSION_NAME="resume-${RESUME_SESSION_ID:0:8}"
elif [[ "$CONTINUE_SESSION" == "true" ]]; then
  SESSION_NAME="continue-1"
elif [[ -n "${1:-}" && "${1:-}" != "ls" && "${1:-}" != "resume" && "${1:-}" != "last" ]]; then
  SESSION_NAME="$1"
else
  N=1
  while tmux has-session -t "claude-${N}" 2>/dev/null; do
    N=$((N + 1))
  done
  SESSION_NAME="claude-${N}"
fi

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

# Build Claude command based on mode (agf-style: cd to project dir first)
CLAUDE_CMD="claude"
if [[ -n "$RESUME_SESSION_ID" ]]; then
  if [[ -n "${RESUME_PROJECT_PATH:-}" && -d "${RESUME_PROJECT_PATH:-}" ]]; then
    CLAUDE_CMD="cd '${RESUME_PROJECT_PATH}' && claude --resume '$RESUME_SESSION_ID'"
  else
    CLAUDE_CMD="claude --resume '$RESUME_SESSION_ID'"
  fi
elif [[ "$CONTINUE_SESSION" == "true" ]]; then
  CLAUDE_CMD="claude --continue"
fi

# Create new tmux session
tmux new-session -d -s "$SESSION_NAME" -x "$(tput cols)" -y "$(tput lines)"

# Enable mouse mode (scroll, pane select, resize)
tmux set-option -t "$SESSION_NAME" mouse on

# Mouse drag → copy-mode → auto-copy to system clipboard on release
# (Hold Shift while dragging for native terminal selection)
tmux set-option -t "$SESSION_NAME" set-clipboard off
tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"
tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"

# Set session-level env var for isolation
tmux set-environment -t "$SESSION_NAME" CLAUDE_PANEL_ID "$SESSION_NAME"

# Keybinding: Ctrl-b u → undo last change
UNDO_SCRIPT="$SCRIPT_DIR/undo.sh"
if [[ -x "$UNDO_SCRIPT" ]]; then
  tmux bind-key -T prefix u run-shell "$UNDO_SCRIPT"
fi

# Split: right pane for dashboard
tmux split-window -h -l "$PANEL_WIDTH" -t "$SESSION_NAME"

# Right pane (index 1): no scrollback (prevents scroll chaos on HUD)
tmux set-option -t "$SESSION_NAME:0.1" -p history-limit 0

# Right pane (index 1): start dashboard with panel ID
tmux send-keys -t "$SESSION_NAME:0.1" "export CLAUDE_PANEL_ID='$SESSION_NAME' && $PANEL_SCRIPT" Enter

# Left pane (index 0): start claude with panel ID; kill session on exit
tmux send-keys -t "$SESSION_NAME:0.0" "export CLAUDE_PANEL_ID='$SESSION_NAME' CLAUDE_STATUSLINE_QUIET=1 && clear && $CLAUDE_CMD; tmux kill-session -t '$SESSION_NAME' 2>/dev/null" Enter

# Focus left pane (Claude Code)
tmux select-pane -t "$SESSION_NAME:0.0"

# Attach
tmux attach -t "$SESSION_NAME"
