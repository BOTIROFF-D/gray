#!/bin/sh
set -eu
cd "$GRAY_MNT"
printf '{"name":"t","version":"v1"}\n' > package.json
sync
npm pkg set version=v2 >/dev/null 2>&1
gray ack v2
