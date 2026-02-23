#!/bin/bash
# Claude Code PreToolUse hook — auto-checkpoint before Edit/Write
# Saves file snapshots to a stack for undo support
#
# Hook config in ~/.claude/settings.json:
# "hooks": {
#   "PreToolUse": [{
#     "matcher": "Edit|Write",
#     "command": "~/.claude/scripts/checkpoint.sh"
#   }]
# }

set -euo pipefail

CHECKPOINT_DIR="$HOME/.claude/.tmux-hud-cache/checkpoints"
STACK_FILE="$CHECKPOINT_DIR/stack.json"
MAX_CHECKPOINTS=20

# Read tool input from stdin (Claude Code passes JSON)
INPUT=$(cat)

# Extract tool name and file path
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)

# Only checkpoint Edit/Write with a valid file path
if [[ -z "$TOOL_NAME" || -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip if file doesn't exist yet (new file creation)
if [[ ! -f "$FILE_PATH" ]]; then
  # Still record it in the stack (for undo = delete)
  mkdir -p "$CHECKPOINT_DIR"
  TIMESTAMP=$(date +%s)
  ENTRY=$(jq -n \
    --arg tool "$TOOL_NAME" \
    --arg file "$FILE_PATH" \
    --arg ts "$TIMESTAMP" \
    --arg backup "" \
    --argjson is_new true \
    '{tool: $tool, file: $file, timestamp: ($ts | tonumber), backup: $backup, is_new: $is_new}')

  if [[ -f "$STACK_FILE" ]]; then
    jq --argjson entry "$ENTRY" --argjson max "$MAX_CHECKPOINTS" \
      '[$entry] + . | .[:$max]' "$STACK_FILE" > "$STACK_FILE.tmp" && mv "$STACK_FILE.tmp" "$STACK_FILE"
  else
    echo "[$ENTRY]" | jq . > "$STACK_FILE"
  fi
  exit 0
fi

# Create checkpoint directory
mkdir -p "$CHECKPOINT_DIR/files"

# Generate unique backup filename
TIMESTAMP=$(date +%s)
SAFE_NAME=$(echo "$FILE_PATH" | tr '/' '_')
BACKUP_PATH="$CHECKPOINT_DIR/files/${TIMESTAMP}_${SAFE_NAME}"

# Copy the current file as backup
cp "$FILE_PATH" "$BACKUP_PATH"

# Add to stack (newest first)
ENTRY=$(jq -n \
  --arg tool "$TOOL_NAME" \
  --arg file "$FILE_PATH" \
  --arg ts "$TIMESTAMP" \
  --arg backup "$BACKUP_PATH" \
  --argjson is_new false \
  '{tool: $tool, file: $file, timestamp: ($ts | tonumber), backup: $backup, is_new: $is_new}')

if [[ -f "$STACK_FILE" ]]; then
  jq --argjson entry "$ENTRY" --argjson max "$MAX_CHECKPOINTS" \
    '[$entry] + . | .[:$max]' "$STACK_FILE" > "$STACK_FILE.tmp" && mv "$STACK_FILE.tmp" "$STACK_FILE"
else
  echo "[$ENTRY]" | jq . > "$STACK_FILE"
fi

# Cleanup old backups beyond MAX_CHECKPOINTS
BACKUP_COUNT=$(ls "$CHECKPOINT_DIR/files/" 2>/dev/null | wc -l | tr -d ' ')
if (( BACKUP_COUNT > MAX_CHECKPOINTS * 2 )); then
  ls -t "$CHECKPOINT_DIR/files/" | tail -n +$((MAX_CHECKPOINTS + 1)) | while read -r f; do
    rm -f "$CHECKPOINT_DIR/files/$f"
  done
fi
