#!/bin/sh
# The strictest setting git offers. It fsyncs the files — and still never
# fsyncs the directories those files are renamed into, so the ref move
# remains at risk.
set -eu
export HOME="$GRAY_MNT"
git init -q "$GRAY_MNT/repo"
cd "$GRAY_MNT/repo"
git config user.email a@b.c; git config user.name gray
git config core.fsync all
echo base > f.txt; git add f.txt; git commit -q -m v1
sync
echo changed > f.txt; git add f.txt; git commit -q -m v2
gray ack v2
