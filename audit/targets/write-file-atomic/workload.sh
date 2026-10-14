#!/bin/sh
# The package npm itself uses for atomic writes.
set -eu
printf 'v1' > "$GRAY_MNT/data"; sync
NODE_PATH=/Users/botiroff/gray/audit/node_modules node -e '
require("write-file-atomic").sync(process.argv[1]+"/data","v2");
' "$GRAY_MNT"
gray ack v2
