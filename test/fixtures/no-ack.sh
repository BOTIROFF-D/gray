#!/bin/sh
# A workload that never promises anything. gray must refuse to call this a pass.
set -eu
printf saved > "$GRAY_MNT/data"
