#!/bin/sh
# git documents its own default: "equivalent to core.fsync=committed,
# -loose-object, which has good performance, but risks losing recent work
# in the event of an unclean system shutdown."
set -eu
export HOME="$GRAY_MNT"
git init -q "$GRAY_MNT/repo"
cd "$GRAY_MNT/repo"
git config user.email a@b.c; git config user.name gray
echo base > f.txt; git add f.txt; git commit -q -m v1
sync
echo changed > f.txt; git add f.txt; git commit -q -m v2
gray ack v2
