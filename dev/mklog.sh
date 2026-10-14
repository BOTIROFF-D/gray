#!/bin/sh
# Captures the journal of a real workload and leaves it as a file, so the
# parser and the replay can be cross-checked against the reference on it.
#
#   sudo sh dev/mklog.sh [workdir]
#
# Used by CI before test/parser-crosscheck.ts and test/replay-crosscheck.ts.
set -eu
WORK=${1:-/var/tmp/gray-log}
MNT=$WORK/mnt

cleanup() {
  umount "$MNT" 2>/dev/null || true
  dmsetup remove graylog 2>/dev/null || true
  for img in data log; do
    for l in $(losetup -j "$WORK/$img.img" 2>/dev/null | cut -d: -f1); do
      losetup -d "$l" 2>/dev/null || true
    done
  done
}
trap cleanup EXIT

cleanup
rm -rf "$WORK"
mkdir -p "$WORK" "$MNT"
truncate -s 256M "$WORK/data.img" "$WORK/log.img"

DATA=$(losetup --show -f "$WORK/data.img")
LOG=$(losetup --show -f "$WORK/log.img")
dmsetup create graylog --table "0 $(blockdev --getsz "$DATA") log-writes $DATA $LOG"

mkfs.ext4 -q -F /dev/mapper/graylog
mount -o data=ordered /dev/mapper/graylog "$MNT"

printf 'OLD' > "$MNT/config.json"
sync
dmsetup message graylog 0 mark baseline

# The write-file-atomic recipe: fsync the file, rename it into place, never
# touch the directory.
python3 -c "
import os, sys
d = sys.argv[1]
fd = os.open(d + '/config.json.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.write(fd, b'NEW'); os.fsync(fd); os.close(fd)
os.rename(d + '/config.json.tmp', d + '/config.json')" "$MNT"

dmsetup message graylog 0 mark acked
umount "$MNT"
dmsetup remove graylog

cp "$WORK/log.img" "$WORK/journal.bin"
chmod 644 "$WORK/journal.bin"
echo "journal captured: $WORK/journal.bin"
