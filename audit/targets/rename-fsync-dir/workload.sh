#!/bin/sh
# The same recipe, finished. gray must stay quiet on this one.
#
# A tool that cries wolf on correct code is worse than no tool: it loses its
# credibility exactly when it finds a real loss.
set -eu
printf 'v1' > "$GRAY_MNT/data"; sync
node -e '
const fs=require("fs"), p=process.argv[1];
const fd=fs.openSync(p+"/data.tmp","w");
fs.writeSync(fd,"v2"); fs.fsyncSync(fd); fs.closeSync(fd);
fs.renameSync(p+"/data.tmp", p+"/data");
const d=fs.openSync(p,"r"); fs.fsyncSync(d); fs.closeSync(d);
' "$GRAY_MNT"
gray ack v2
