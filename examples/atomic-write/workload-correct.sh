#!/bin/sh
# The same recipe, finished: the directory is fsynced after the rename.
# This is the control gray must stay quiet on.
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
dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
os.fsync(dfd)       # fsync of the directory — this is the whole difference
os.close(dfd)
PY

# The app would return success here: for the user, the file is saved.
gray ack v2
