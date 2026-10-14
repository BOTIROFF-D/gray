#!/bin/sh
set -eu
node --input-type=module -e '
const {default: Conf} = await import("/Users/botiroff/gray/audit/node_modules/conf/dist/source/index.js");
new Conf({cwd: process.argv[1], projectName: "gray", configName: "data", fileExtension: ""}).set("k","v1");
' "$GRAY_MNT"
sync
node --input-type=module -e '
const {default: Conf} = await import("/Users/botiroff/gray/audit/node_modules/conf/dist/source/index.js");
new Conf({cwd: process.argv[1], projectName: "gray", configName: "data", fileExtension: ""}).set("k","v2");
' "$GRAY_MNT"
gray ack v2
