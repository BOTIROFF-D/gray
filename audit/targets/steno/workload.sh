#!/bin/sh
set -eu
printf 'v1' > "$GRAY_MNT/data"; sync
node --input-type=module -e '
const {Writer} = await import("/Users/botiroff/gray/audit/node_modules/steno/lib/index.js");
await new Writer(process.argv[1]+"/data").write("v2");
' "$GRAY_MNT"
gray ack v2
