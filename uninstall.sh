#!/bin/bash
# claude-code-tmux-hud uninstaller
# curl -fsSL https://raw.githubusercontent.com/sokojh/claude-code-tmux-hud/main/uninstall.sh | bash
set -euo pipefail

INSTALL_DIR="$HOME/.claude/scripts"
SETTINGS="$HOME/.claude/settings.json"

RED='\033[31m'; GRN='\033[32m'; YLW='\033[33m'; CYN='\033[36m'; RST='\033[0m'
info()  { printf "${CYN}[info]${RST} %s\n" "$1"; }
ok()    { printf "${GRN}[ok]${RST} %s\n" "$1"; }
warn()  { printf "${YLW}[warn]${RST} %s\n" "$1"; }

echo ""
echo "Uninstalling claude-code-tmux-hud..."
echo ""

# 1. Check for active tmux sessions
active=$(tmux ls 2>/dev/null | grep -c "^claude-" || true)
if (( active > 0 )); then
  warn "$active active claude session(s) found"
  printf "Continue? (y/N) "
  read -r reply
  [[ "$reply" != [yY] ]] && { echo "Aborted."; exit 0; }
fi

# 2. Remove scripts (files only, preserve directory)
for f in statusline.mjs tmux-panel.sh claude-tmux.sh session-picker.mjs; do
  if [[ -f "$INSTALL_DIR/$f" ]]; then
    rm -f "$INSTALL_DIR/$f"
    ok "Removed $f"
  fi
done

# 3. Remove cache directories
if [[ -d "$HOME/.claude/.tmux-hud-cache" ]]; then
  rm -rf "$HOME/.claude/.tmux-hud-cache"
  ok "Removed cache directory"
fi

# Remove /tmp caches
rm -f /tmp/claude-panel-*.json /tmp/claude-statusline-cache.json /tmp/claude-git-cache.json 2>/dev/null
ok "Removed temp files"

# 4. Remove statusLine from settings.json (preserve other keys)
if [[ -f "$SETTINGS" ]] && command -v jq &>/dev/null; then
  cp "$SETTINGS" "$SETTINGS.pre-uninstall.bak"

  if jq -e '.statusLine' "$SETTINGS" &>/dev/null; then
    jq 'del(.statusLine)' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
    ok "Removed statusLine from settings.json (backup: .pre-uninstall.bak)"
  fi
fi
rm -f "$SETTINGS.bak" 2>/dev/null

# 5. Remove shell alias (only our block)
remove_alias() {
  local rc="$1"
  [[ ! -f "$rc" ]] && return
  if ! grep -qF "claude-tmux.sh" "$rc" 2>/dev/null; then return; fi
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' '/# Claude Code tmux HUD/d' "$rc"
    sed -i '' '/alias ct=.*claude-tmux\.sh/d' "$rc"
  else
    sed -i '/# Claude Code tmux HUD/d' "$rc"
    sed -i '/alias ct=.*claude-tmux\.sh/d' "$rc"
  fi
  ok "Removed alias from $rc"
}

remove_alias "$HOME/.zshrc"
remove_alias "$HOME/.bashrc"

echo ""
echo "Uninstalled. Restart your shell to complete."
echo ""
