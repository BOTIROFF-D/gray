#!/bin/sh
# Replays the exact sequence of write-file-atomic@8 — the package inside
# the npm CLI itself, 102M downloads a week:
#
#   open(tmp) -> write -> fsync(file) -> close -> rename(tmp, target)
#
# The directory is never synced. That is what we are testing.
set -eu
printf 'v1' > "$GRAY_MNT/config.json"
sync

python3 - "$GRAY_MNT" <<'PY'
import os, sys
d = sys.argv[1]
tmp, target = os.path.join(d, "config.json.tmp"), os.path.join(d, "config.json")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.write(fd, b"v2")
os.fsync(fd)        # fsync of the file — this part write-file-atomic does
os.close(fd)
os.rename(tmp, target)
PY

# The app would return success here: for the user, the file is saved.
gray ack v2
