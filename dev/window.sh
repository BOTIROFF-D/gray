#!/bin/sh
# How long are you exposed, and what sets the width of the window?
#
#   sudo sh dev/window.sh
#
# The common expectation is that the kernel flushes everything within
# dirty_expire_centisecs — thirty seconds by default. It does not: on ext4 the
# boundary is held by the journal commit interval. If that is so, then raising
# `commit` for performance, advice you will find in plenty of tuning guides,
# widens the window to lose data in by the same factor.
#
# This uses nothing but gray itself. `--settle n` asks "if the machine stayed
# up n seconds after the save, is the save safe yet?" — so sweeping n finds
# where the window closes.
set -eu
cd "$(dirname "$0")/.."
[ -f dist/cli.js ] || { echo "run npm run build first" >&2; exit 1; }

W=./examples/atomic-write/workload.sh
C=./examples/atomic-write/check.sh

sweep() {
  mount_opts="$1"; shift
  echo "-- $mount_opts --"
  for s in "$@"; do
    v=$(node dist/cli.js run --workload "$W" --check "$C" \
          --mount-options "$mount_opts" --settle "$s" 2>/dev/null \
        | grep -oE '^(PASS|FAIL|INCONCLUSIVE)' || echo '?')
    case "$v" in
      PASS) verdict="safe by then" ;;
      FAIL) verdict="STILL LOSES" ;;
      *)    verdict="$v" ;;
    esac
    printf '  survived %-3s s after the save  ->  %s\n' "$s" "$verdict"
  done
  echo
}

echo "kernel $(uname -r) · ext4"
echo
sweep 'data=ordered,commit=1'  0 2 4
sweep 'data=ordered,commit=5'  0 3 7 10
sweep 'data=ordered,commit=60' 0 30 70
