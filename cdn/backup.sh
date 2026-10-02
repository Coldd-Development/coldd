#!/bin/bash
# cdn/backup.sh - nightly backup of ALL stored files (public images + private
# product files) to the Hetzner Storage Box. Run from Hestia cron (see cdn/README.md).
# Keeps a full mirror plus dated copies of anything changed or deleted, so a
# bad upload or accidental delete is recoverable for 30 days.
#
# Needs rsync + ssh on the hosting account, and a Storage Box with SSH enabled
# and this account's public key installed. Config in ~/.cdn-backup.env:
#   BOX_USER=u123456  BOX_HOST=u123456.your-storagebox.de  BOX_DIR=coldd-cdn
#   SRC_PUBLIC=/home/<hestia-user>/web/cdn.coldd.dev/public_html
#   SRC_PRIVATE=/home/<hestia-user>/web/cdn.coldd.dev/private-files
#   SSH_KEY=~/.ssh/storagebox_ed25519

set -euo pipefail
source "$HOME/.cdn-backup.env"
STAMP=$(date +%Y-%m-%d)
SSH="ssh -p 23 -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

sync_dir() { # src  dest-subdir  [extra rsync args]
  local src="$1" sub="$2"; shift 2
  # Refuse to run against an empty/missing source so a broken mount can't wipe the backup.
  [ -d "$src" ] && [ "$(find "$src" -type f | head -1)" ] || { echo "backup: $src empty or missing, skipping" >&2; return 0; }
  # Changed/deleted files are moved into a dated folder instead of being lost.
  rsync -a --delete --backup --backup-dir="../../archive/$STAMP/$sub" \
    --exclude '*.part*' --exclude '.up-*' "$@" \
    -e "$SSH" "$src/" "$BOX_USER@$BOX_HOST:$BOX_DIR/current/$sub/"
}

$SSH "$BOX_USER@$BOX_HOST" "mkdir -p $BOX_DIR/current/public $BOX_DIR/current/private $BOX_DIR/archive"
sync_dir "$SRC_PUBLIC"  public  --exclude 'upload.php' --exclude 'download.php'
sync_dir "$SRC_PRIVATE" private

# Prune dated archives older than 30 days.
$SSH "$BOX_USER@$BOX_HOST" "find $BOX_DIR/archive -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +" || true
echo "backup: ok $STAMP"
