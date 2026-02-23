#!/bin/bash
# Undo last file change from checkpoint stack
# Usage: undo.sh [number]  — undo the Nth most recent change (default: 1)

set -euo pipefail

CHECKPOINT_DIR="$HOME/.claude/.tmux-hud-cache/checkpoints"
STACK_FILE="$CHECKPOINT_DIR/stack.json"

RED='\033[31m'; GRN='\033[32m'; YLW='\033[33m'; CYN='\033[36m'; RST='\033[0m'; DIM='\033[2m'

if [[ ! -f "$STACK_FILE" ]]; then
  echo -e "${DIM}No checkpoints available${RST}"
  exit 0
fi

STACK_LEN=$(jq 'length' "$STACK_FILE" 2>/dev/null || echo "0")
if (( STACK_LEN == 0 )); then
  echo -e "${DIM}No checkpoints available${RST}"
  exit 0
fi

# Which entry to undo (1-indexed, newest first)
IDX=${1:-1}
if (( IDX < 1 || IDX > STACK_LEN )); then
  echo -e "${RED}Invalid index: $IDX (stack has $STACK_LEN entries)${RST}"
  exit 1
fi

# Get the entry (0-indexed in jq)
JQ_IDX=$((IDX - 1))
ENTRY=$(jq ".[$JQ_IDX]" "$STACK_FILE")

FILE_PATH=$(echo "$ENTRY" | jq -r '.file')
BACKUP_PATH=$(echo "$ENTRY" | jq -r '.backup')
IS_NEW=$(echo "$ENTRY" | jq -r '.is_new')
TOOL_NAME=$(echo "$ENTRY" | jq -r '.tool')

FILENAME="${FILE_PATH##*/}"

if [[ "$IS_NEW" == "true" ]]; then
  # File was newly created — undo = delete it
  if [[ -f "$FILE_PATH" ]]; then
    rm -f "$FILE_PATH"
    echo -e "${GRN}Undone${RST} ${TOOL_NAME} ${CYN}${FILENAME}${RST} ${DIM}(deleted new file)${RST}"
  else
    echo -e "${DIM}File already removed: $FILENAME${RST}"
  fi
elif [[ -f "$BACKUP_PATH" ]]; then
  # Restore from backup
  cp "$BACKUP_PATH" "$FILE_PATH"
  echo -e "${GRN}Undone${RST} ${TOOL_NAME} ${CYN}${FILENAME}${RST} ${DIM}(restored)${RST}"
else
  echo -e "${RED}Backup not found for $FILENAME${RST}"
  exit 1
fi

# Remove the entry from stack
jq "del(.[$JQ_IDX])" "$STACK_FILE" > "$STACK_FILE.tmp" && mv "$STACK_FILE.tmp" "$STACK_FILE"

# Clean up backup file
[[ -n "$BACKUP_PATH" && -f "$BACKUP_PATH" ]] && rm -f "$BACKUP_PATH"
