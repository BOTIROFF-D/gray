#!/bin/sh
set -eu
printf 'v1' > "$GRAY_MNT/data"; sync
node --input-type=module -e '
const {writeFileSync} = await import("/Users/botiroff/gray/audit/node_modules/atomically/dist/index.js");
writeFileSync(process.argv[1]+"/data","v2");
' "$GRAY_MNT"
gray ack v2
