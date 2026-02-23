#!/bin/bash
# claude-code-tmux-hud installer
# curl -fsSL https://raw.githubusercontent.com/sokojh/claude-code-tmux-hud/main/install.sh | bash
set -euo pipefail

VERSION="1.0.0"
REPO="sokojh/claude-code-tmux-hud"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"
INSTALL_DIR="$HOME/.claude/scripts"
SETTINGS="$HOME/.claude/settings.json"
IS_UPDATE=false

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --update) IS_UPDATE=true ;;
  esac
done

# Colors
RED='\033[31m'; GRN='\033[32m'; YLW='\033[33m'; CYN='\033[36m'; RST='\033[0m'; BOLD='\033[1m'
info()  { printf "${CYN}[info]${RST} %s\n" "$1"; }
ok()    { printf "${GRN}[ok]${RST} %s\n" "$1"; }
warn()  { printf "${YLW}[warn]${RST} %s\n" "$1"; }
err()   { printf "${RED}[error]${RST} %s\n" "$1" >&2; }

# 1. Check dependencies
check_deps() {
  local missing=()
  if ! command -v node &>/dev/null; then missing+=("node"); fi
  if ! command -v tmux &>/dev/null; then missing+=("tmux"); fi
  if ! command -v jq &>/dev/null; then missing+=("jq"); fi
  if ! command -v curl &>/dev/null; then missing+=("curl"); fi

  if (( ${#missing[@]} > 0 )); then
    err "Missing dependencies: ${missing[*]}"
    echo ""
    echo "Install via:"
    if command -v brew &>/dev/null; then
      echo "  brew install ${missing[*]}"
    elif command -v apt-get &>/dev/null; then
      echo "  sudo apt-get install ${missing[*]}"
    else
      echo "  Please install: ${missing[*]}"
    fi
    exit 1
  fi

  # Node.js version check (18+)
  local ver
  ver=$(node -e "console.log(process.versions.node.split('.')[0])")
  if (( ver < 18 )); then
    err "Node.js 18+ required (found v$ver)"
    exit 1
  fi
}

# 2. Download scripts
download_scripts() {
  mkdir -p "$INSTALL_DIR"
  local files=("statusline.mjs" "tmux-panel.sh" "claude-tmux.sh")
  for f in "${files[@]}"; do
    info "Downloading $f..."
    if curl -fsSL "$BASE_URL/scripts/$f" -o "$INSTALL_DIR/$f"; then
      chmod +x "$INSTALL_DIR/$f"
      ok "$f installed"
    else
      err "Failed to download $f"
      exit 1
    fi
  done
}

# 3. Configure settings.json (statusLine)
configure_settings() {
  local node_path
  node_path=$(command -v node)
  local cmd="$node_path $INSTALL_DIR/statusline.mjs"

  if [[ -f "$SETTINGS" ]]; then
    # Skip if statusLine already configured with the same command
    local current
    current=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || echo "")
    if [[ "$current" == "$cmd" ]]; then
      info "statusLine already configured, skipping"
      return
    fi

    # Only backup if this is the first modification (preserve original)
    if [[ ! -f "$SETTINGS.bak" ]]; then
      cp "$SETTINGS" "$SETTINGS.bak"
    fi
    jq --arg cmd "$cmd" '.statusLine = {"type":"command","command":$cmd}' \
      "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
    ok "settings.json updated (backup: settings.json.bak)"
  else
    mkdir -p "$(dirname "$SETTINGS")"
    printf '{"statusLine":{"type":"command","command":"%s"}}' "$cmd" | jq . > "$SETTINGS"
    ok "settings.json created"
  fi
}

# 4. Setup shell alias
setup_alias() {
  local alias_line="alias ct='$INSTALL_DIR/claude-tmux.sh'"
  local comment="# Claude Code tmux HUD"

  # Determine shell rc file
  local rc=""
  if [[ -f "$HOME/.zshrc" ]]; then
    rc="$HOME/.zshrc"
  elif [[ -f "$HOME/.bashrc" ]]; then
    rc="$HOME/.bashrc"
  elif [[ -n "${SHELL:-}" ]]; then
    case "$SHELL" in
      */zsh)  rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
    esac
  fi

  if [[ -z "$rc" ]]; then
    warn "Could not detect shell rc file"
    echo "  Add manually: $alias_line"
    return
  fi

  # Check for existing ct alias
  if grep -qF "alias ct=" "$rc" 2>/dev/null; then
    if grep -qF "claude-tmux.sh" "$rc" 2>/dev/null; then
      info "'ct' alias already configured in $rc"
      return
    fi
    warn "'ct' alias already exists in $rc (different target)"
    echo "  Replace manually: $alias_line"
    return
  fi

  printf '\n%s\n%s\n' "$comment" "$alias_line" >> "$rc"
  ok "Added 'ct' alias to $rc"
}

# Main
main() {
  echo ""
  printf "${BOLD}${CYN}claude-code-tmux-hud${RST} v${VERSION}\n"
  if [[ "$IS_UPDATE" == "true" ]]; then
    echo "Updating..."
  else
    echo "Installing..."
  fi
  echo ""

  check_deps
  download_scripts

  if [[ "$IS_UPDATE" == "false" ]]; then
    configure_settings
    setup_alias
  else
    configure_settings
  fi

  # Clear update check cache so next ct run doesn't show stale notification
  rm -f "$HOME/.claude/.tmux-hud-cache/update-check" "$HOME/.claude/.tmux-hud-cache/update-check.result" 2>/dev/null

  echo ""
  printf "${BOLD}${GRN}Installation complete!${RST}\n"
  echo ""
  echo "Usage:"
  echo "  1. Restart your shell (or run: source ~/.zshrc)"
  echo "  2. Run: ct"
  echo ""
  echo "Commands:"
  echo "  ct                 Launch Claude Code with HUD"
  echo "  ct work            Named session"
  echo "  ct --help          Show help"
  echo "  ct --update        Update to latest version"
  echo ""
  echo "Uninstall:"
  echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/uninstall.sh | bash"
  echo ""
}

main
