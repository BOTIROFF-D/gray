#!/bin/sh
set -eu
node -e 'require("fs").writeFileSync(process.argv[1]+"/data","v2")' "$GRAY_MNT"
gray ack v2
