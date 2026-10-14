#!/bin/sh
# The recipe everyone copies. It is one syscall short.
set -eu
printf 'v1' > "$GRAY_MNT/data"; sync
node -e '
const fs=require("fs"), p=process.argv[1];
const fd=fs.openSync(p+"/data.tmp","w");
fs.writeSync(fd,"v2"); fs.fsyncSync(fd); fs.closeSync(fd);
fs.renameSync(p+"/data.tmp", p+"/data");
' "$GRAY_MNT"
gray ack v2
