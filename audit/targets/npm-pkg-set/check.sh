#!/bin/sh
set -eu
want=$(printf '%s' "${GRAY_ACKED:-}" | tail -n 1)
[ -z "$want" ] && exit 0
got=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/package.json","utf8")).version)}catch(e){console.log("<unreadable>")}' "$GRAY_MNT" 2>/dev/null || echo '<unreadable>')
[ "$got" = "$want" ] && exit 0
echo "acknowledged \"$want\", found \"$got\" after recovery"
exit 1
