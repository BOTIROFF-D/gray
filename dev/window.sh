#!/bin/sh
# How wide the loss window is, and what sets its width.
#
#   sudo sh dev/window.sh
#
# The common expectation is that the kernel flushes everything within
# dirty_expire_centisecs, thirty seconds by default. It does not: on ext4 the
# boundary is held by the journal commit interval. If that is so, then raising
# `commit` for performance — advice you will find in a lot of tuning guides —
# widens the window by the same factor.
#
# Reproduces the table in README under "loses does not mean always".
set -eu
WORK=/var/tmp/gray-window
REPLAY_BIN=${GRAY_REPLAY:-$HOME/ref/replay-log}
MNT=$WORK/mnt
RMNT=$WORK/rmnt

cleanup() {
  umount "$MNT" 2>/dev/null || true
  umount "$RMNT" 2>/dev/null || true
  dmsetup remove graylog 2>/dev/null || true
  for img in data log replay; do
    for l in $(losetup -j "$WORK/$img.img" 2>/dev/null | cut -d: -f1); do
      losetup -d "$l" 2>/dev/null || true
    done
  done
}
trap cleanup EXIT

probe() {
  DELAY="$1"; MOPTS="$2"
  cleanup; rm -rf "$WORK"; mkdir -p "$WORK" "$MNT" "$RMNT"
  truncate -s 256M "$WORK/data.img" "$WORK/log.img" "$WORK/replay.img"
  DATA=$(losetup --show -f "$WORK/data.img")
  LOG=$(losetup --show -f "$WORK/log.img")
  REPLAY=$(losetup --show -f "$WORK/replay.img")
  dmsetup create graylog --table "0 $(blockdev --getsz "$DATA") log-writes $DATA $LOG"
  mkfs.ext4 -q -F /dev/mapper/graylog
  mount -o "$MOPTS" /dev/mapper/graylog "$MNT"

  printf 'OLD' > "$MNT/config.json"; sync
  python3 -c "
import os, sys
d = sys.argv[1]
fd = os.open(d + '/config.json.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.write(fd, b'NEW'); os.fsync(fd); os.close(fd)
os.rename(d + '/config.json.tmp', d + '/config.json')" "$MNT"

  # DELAY is how long the machine kept running after the app said "saved".
  [ "$DELAY" != "0" ] && sleep "$DELAY"
  dmsetup message graylog 0 mark acked
  umount "$MNT"; dmsetup remove graylog

  "$REPLAY_BIN" --log "$LOG" --replay "$REPLAY" --end-mark acked >/dev/null
  mount "$REPLAY" "$RMNT"
  GOT=$(cat "$RMNT/config.json" 2>/dev/null || echo NONE)
  umount "$RMNT"
  [ "$GOT" = "NEW" ] && echo "intact" || echo "LOST"
}

echo "kernel $(uname -r) · ext4"
echo
echo "-- commit=5 (the default) --"
for d in 0 1 2 3 4 5 6 8; do
  printf '  power cut after %-4s s  ->  %s\n' "$d" "$(probe "$d" 'data=ordered,commit=5')"
done
echo
echo "-- commit=60 (a common performance tip) --"
for d in 0 10 30 61 70; do
  printf '  power cut after %-4s s  ->  %s\n' "$d" "$(probe "$d" 'data=ordered,commit=60')"
done
