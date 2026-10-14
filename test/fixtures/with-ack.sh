#!/bin/sh
set -eu
printf saved > "$GRAY_MNT/data"
gray ack saved
