#!/bin/bash
# Claude Code tmux side panel — real-time dashboard
# Cross-platform: macOS + Linux
set -euo pipefail

PANEL_ID="${CLAUDE_PANEL_ID:-}"
if [[ -n "$PANEL_ID" ]]; then
  STATE_FILE="/tmp/claude-panel-${PANEL_ID}.json"
else
  STATE_FILE="/tmp/claude-panel-state.json"
fi

RST="\033[0m"; BOLD="\033[1m"; DIM="\033[2m"
RED="\033[31m"; GRN="\033[38;5;208m"; YLW="\033[38;5;202m"
CYN="\033[36m"; WHT="\033[37m"; GRAY="\033[90m"; MAG="\033[35m"

pbar() {
  local pct=${1:-0} w=${2:-20} color="${3:-$GRN}"
  local filled=$((pct * w / 100))
  (( filled < 1 && pct > 0 )) && filled=1
  local empty=$((w - filled))
  printf "${color}"
  if (( filled > 0 )); then
    for ((i=0; i<filled; i++)); do printf '█'; done
  fi
  # Gradient fade
  if (( empty >= 2 )); then
    printf '▓▒'
    empty=$((empty - 2))
  elif (( empty == 1 )); then
    printf '▓'
    empty=0
  fi
  printf "${GRAY}"
  for ((i=0; i<empty; i++)); do printf '░'; done
  printf "${RST}"
}

time_left() {
  local iso="$1"
  [[ -z "$iso" || "$iso" == "null" ]] && return
  local reset_ts now_ts diff_s
  # Cross-platform date parsing (Linux: date -d, macOS: date -j)
  if date -d "2000-01-01" "+%s" &>/dev/null; then
    # GNU date (Linux)
    reset_ts=$(TZ=UTC date -d "${iso%%.*}" "+%s" 2>/dev/null) || return
  else
    # BSD date (macOS)
    reset_ts=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${iso%%.*}" "+%s" 2>/dev/null) || return
  fi
  now_ts=$(date "+%s")
  diff_s=$((reset_ts - now_ts))
  (( diff_s <= 0 )) && { printf "now"; return; }
  local d=$((diff_s / 86400)) h=$(( (diff_s % 86400) / 3600 )) m=$(( (diff_s % 3600) / 60 ))
  if (( d > 0 )); then
    printf "%dd %dh" "$d" "$h"
  elif (( h > 0 )); then
    printf "%dh %dm" "$h" "$m"
  else
    printf "%dm" "$m"
  fi
}

trunc() { local s="$1" m="${2:-28}"; (( ${#s} > m )) && echo "${s:0:$((m-2))}.." || echo "$s"; }

panel() { jq -r "._panel.$1" "$STATE_FILE" 2>/dev/null; }
raw()   { jq -r ".$1" "$STATE_FILE" 2>/dev/null; }

P() { printf "  %b\n" "$1"; }
H() { printf "\n  ${CYN}${BOLD}%b${RST}\n" "$1"; }

render() {
  printf "\n"
  P "${BOLD}${CYN}Claude Code HUD${RST}"
  P "${DIM}$(date '+%H:%M:%S')${RST}"

  # -- Session
  if [[ ! -f "$STATE_FILE" ]] || [[ ! -s "$STATE_FILE" ]]; then
    H "Session"
    P "${DIM}Waiting for Claude Code...${RST}"
    return
  fi

  local model pct dur plan
  model=$(raw 'model.display_name // "Unknown"')
  pct=$(panel 'contextPercent // 0')
  dur=$(panel 'duration // ""')
  plan=$(panel 'usage.planName // ""')

  local color="$GRN"
  (( pct >= 85 )) && color="$RED"
  (( pct >= 70 && pct < 85 )) && color="$YLW"

  H "Session"
  local model_str="${WHT}${model}${RST}"
  [[ -n "$plan" && "$plan" != "null" ]] && model_str+=" ${DIM}| ${plan}${RST}"
  P "${model_str}"
  P "$(pbar "$pct" 22 "$color") ${color}${BOLD}${pct}%${RST}"

  local used total
  used=$(raw 'context_window.current_usage.input_tokens // 0')
  total=$(raw 'context_window.context_window_size // 200000')
  local used_k=$((used / 1000)) total_k=$((total / 1000))
  P "${DIM}${used_k}k / ${total_k}k tokens${RST}"
  [[ -n "$dur" && "$dur" != "" && "$dur" != "null" ]] && P "${DIM}Session: ${dur}${RST}"

  # -- Usage (always shown)
  H "Usage"
  if [[ -z "$plan" || "$plan" == "null" ]]; then
    P "${DIM}No plan info${RST}"
  else
    local five_h seven_d
    five_h=$(panel 'usage.fiveHour // empty')
    seven_d=$(panel 'usage.sevenDay // empty')

    if [[ (-z "$five_h" || "$five_h" == "null") && (-z "$seven_d" || "$seven_d" == "null") ]]; then
      P "${DIM}Loading...${RST}"
    else
      if [[ -n "$five_h" && "$five_h" != "null" ]]; then
        local c="$GRN"; (( five_h >= 85 )) && c="$RED"; (( five_h >= 70 && five_h < 85 )) && c="$YLW"
        local reset_5h
        reset_5h=$(panel 'usage.fiveHourResetAt // ""')
        local tl_5h=""
        if [[ -n "$reset_5h" && "$reset_5h" != "null" ]]; then
          tl_5h=$(time_left "$reset_5h")
          [[ -n "$tl_5h" ]] && tl_5h=" ${DIM}(${tl_5h})${RST}"
        fi
        P "5h $(pbar "$five_h" 14 "$c") ${c}${five_h}%${RST}${tl_5h}"
      fi
      if [[ -n "$seven_d" && "$seven_d" != "null" ]]; then
        local c="$GRN"; (( seven_d >= 85 )) && c="$RED"; (( seven_d >= 70 && seven_d < 85 )) && c="$YLW"
        local reset_7d
        reset_7d=$(panel 'usage.sevenDayResetAt // ""')
        local tl_7d=""
        if [[ -n "$reset_7d" && "$reset_7d" != "null" ]]; then
          tl_7d=$(time_left "$reset_7d")
          [[ -n "$tl_7d" ]] && tl_7d=" ${DIM}(${tl_7d})${RST}"
        fi
        P "7d $(pbar "$seven_d" 14 "$c") ${c}${seven_d}%${RST}${tl_7d}"
      fi
    fi
  fi

  # -- TODO
  local total_todos
  total_todos=$(panel 'todos | length')
  H "TODO"
  if [[ "$total_todos" == "0" || "$total_todos" == "null" ]]; then
    P "${DIM}No active todos${RST}"
  else
    local completed
    completed=$(panel '[todos[] | select(.status == "completed")] | length')
    P "${DIM}${completed}/${total_todos} done${RST}"
    panel 'todos[] | "\(.status)\t\(.subject // .content // "task")"' 2>/dev/null | head -6 | while IFS=$'\t' read -r status content; do
      local icon
      case "$status" in
        completed)   icon="${GRN}v${RST}" ;;
        in_progress) icon="${YLW}>${RST}" ;;
        pending)     icon="${DIM}o${RST}" ;;
        *)           icon="${DIM}.${RST}" ;;
      esac
      P "${icon} $(trunc "$content")"
    done
  fi

  # -- Repository
  H "Repository"
  local branch
  branch=$(panel 'gitStatus.branch // ""')
  if [[ -z "$branch" || "$branch" == "null" ]]; then
    P "${DIM}Not a git repo${RST}"
  else
    local cwd repo_name
    cwd=$(raw 'cwd // ""')
    repo_name="${cwd##*/}"
    P "${WHT}${repo_name}${RST} ${GRN}${branch}${RST}"
    local dirty
    dirty=$(panel 'gitStatus.isDirty // false')
    if [[ "$dirty" == "true" ]]; then
      local m a d u changes=""
      m=$(panel 'gitStatus.fileStats.modified // 0')
      a=$(panel 'gitStatus.fileStats.added // 0')
      d=$(panel 'gitStatus.fileStats.deleted // 0')
      u=$(panel 'gitStatus.fileStats.untracked // 0')
      (( m > 0 )) && changes+="${YLW}~${m}${RST} "
      (( a > 0 )) && changes+="${GRN}+${a}${RST} "
      (( d > 0 )) && changes+="${RED}x${d}${RST} "
      (( u > 0 )) && changes+="${DIM}?${u}${RST}"
      [[ -n "$changes" ]] && P "${changes}"
    else
      P "${DIM}Clean${RST}"
    fi
  fi

  # -- MCP
  H "MCP"
  local names
  names=$(panel 'configs.mcpNames[]? // empty' 2>/dev/null)
  if [[ -n "$names" ]]; then
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      P "${GRN}*${RST} ${name}"
    done <<< "$names"
  else
    P "${DIM}None${RST}"
  fi

  # -- Tools
  H "Tools"
  local running
  running=$(panel '[tools[] | select(.status == "running")] | .[:3][] | .name' 2>/dev/null)
  if [[ -n "$running" ]]; then
    while IFS= read -r name; do
      [[ -z "$name" || "$name" == "null" ]] && continue
      P "${YLW}>${RST} ${CYN}${name}${RST}"
    done <<< "$running"
  fi

  local tool_data
  tool_data=$(panel '[tools[] | select(.status != "running")] | group_by(.name) | map({name: .[0].name, count: length}) | sort_by(-.count) | .[:5][] | "\(.name)\t\(.count)"' 2>/dev/null)
  if [[ -n "$tool_data" ]]; then
    while IFS=$'\t' read -r name count; do
      [[ -z "$name" ]] && continue
      P "${GRN}v${RST} ${name} ${DIM}x${count}${RST}"
    done <<< "$tool_data"
  elif [[ -z "$running" ]]; then
    P "${DIM}No activity${RST}"
  fi

  # -- Changes (undo stack)
  local stack_file="$HOME/.claude/.tmux-hud-cache/checkpoints/stack.json"
  if [[ -f "$stack_file" ]]; then
    local stack_len
    stack_len=$(jq 'length' "$stack_file" 2>/dev/null || echo "0")
    if (( stack_len > 0 )); then
      H "Changes (${stack_len})"
      local now_ts
      now_ts=$(date +%s)
      jq -r '.[:6][] | "\(.tool)\t\(.file)\t\(.timestamp)\t\(.is_new)"' "$stack_file" 2>/dev/null | {
        local idx=0
        while IFS=$'\t' read -r tool filepath ts is_new; do
          idx=$((idx + 1))
          [[ -z "$tool" ]] && continue
          local fname="${filepath##*/}"
          local ago=""
          if [[ -n "$ts" && "$ts" != "null" ]]; then
            local diff_s=$((now_ts - ts))
            if (( diff_s < 60 )); then ago="${diff_s}s"
            elif (( diff_s < 3600 )); then ago="$((diff_s / 60))m"
            else ago="$((diff_s / 3600))h"; fi
          fi
          local op="${CYN}${tool}${RST}"
          [[ "$is_new" == "true" ]] && op="${GRN}+New${RST}"
          P "${DIM}${idx}|${RST} ${op} ${WHT}$(trunc "$fname" 18)${RST} ${DIM}${ago}${RST}"
        done
      }
      P "${DIM}Ctrl-b u → 되돌리기${RST}"
    fi
  fi

  # -- Agents (only if any)
  local agent_data
  agent_data=$(panel 'agents[] | "\(.status)\t\(.type)\t\(.description // "")"' 2>/dev/null)
  if [[ -n "$agent_data" ]]; then
    H "Agents"
    echo "$agent_data" | tail -4 | while IFS=$'\t' read -r status type desc; do
      [[ -z "$type" ]] && continue
      local icon="${GRN}v${RST}"
      [[ "$status" == "running" ]] && icon="${YLW}>${RST}"
      local d=""
      [[ -n "$desc" && "$desc" != "null" ]] && d=" ${DIM}$(trunc "$desc" 20)${RST}"
      P "${icon} ${MAG}${type}${RST}${d}"
    done
  fi

  printf "\n"
}

cleanup() { rm -f "$STATE_FILE" 2>/dev/null; tput cnorm 2>/dev/null; exit 0; }
kill_session() { tmux kill-session -t "$PANEL_ID" 2>/dev/null; cleanup; }
trap cleanup INT TERM EXIT
tput civis 2>/dev/null

STALE_COUNT=0

while true; do
  if [[ -n "$PANEL_ID" ]]; then
    # Auto-exit: if Claude pane (0.0) is gone entirely
    if ! tmux display-message -p -t "${PANEL_ID}:0.0" '' &>/dev/null; then
      kill_session
    fi
    # Auto-exit: if Claude (node) is no longer running in pane 0.0
    pane_cmd=$(tmux display-message -p -t "${PANEL_ID}:0.0" '#{pane_current_command}' 2>/dev/null || echo "")
    if [[ -n "$pane_cmd" && "$pane_cmd" != "node" ]]; then
      STALE_COUNT=$((STALE_COUNT + 1))
      if (( STALE_COUNT >= 3 )); then
        kill_session
      fi
    else
      STALE_COUNT=0
    fi
  fi
  output=$(render 2>/dev/null || true)
  clear
  echo -e "$output"
  sleep 1
done
