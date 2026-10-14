#!/bin/sh
set -eu
want=$(printf '%s' "${GRAY_ACKED:-}" | tail -n 1)
[ -z "$want" ] && exit 0
got=$(sqlite3 "$GRAY_MNT/app.db" "SELECT k FROM t WHERE k='$want';" 2>/dev/null || echo '<database would not open>')
[ "$got" = "$want" ] && exit 0
echo "acknowledged \"$want\", found \"$got\" after recovery"
exit 1
