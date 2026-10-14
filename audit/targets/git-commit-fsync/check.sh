#!/bin/sh
set -eu
want=$(printf '%s' "${GRAY_ACKED:-}" | tail -n 1)
[ -z "$want" ] && exit 0
got=$(git -C "$GRAY_MNT/repo" log -1 --format=%s 2>/dev/null || echo '<repository unreadable>')
[ "$got" = "$want" ] && exit 0
echo "acknowledged \"$want\", found \"$got\" after recovery"
exit 1
