#!/bin/sh
# What must hold after recovery.
#
# $GRAY_ACKED lists the keys the app had already promised as of this crash
# point. Before the first promise any state of the disk is legal and the
# check must stay quiet: a durability violation only exists relative to an
# acknowledgement.
set -eu
want=$(printf '%s' "${GRAY_ACKED:-}" | tail -n 1)
[ -z "$want" ] && exit 0
got=$(cat "$GRAY_MNT/config.json" 2>/dev/null || echo '<no file>')
[ "$got" = "$want" ] && exit 0
echo "acknowledged \"$want\", found \"$got\" after recovery"
exit 1
