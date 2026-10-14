#!/bin/sh
# The same, with synchronous=EXTRA.
#
# From the SQLite docs, verbatim: "EXTRA synchronous is like FULL with the
# addition that the directory containing a rollback journal is synced after
# that journal is unlinked to commit a transaction in DELETE mode. [...]
# Without EXTRA, depending on the underlying filesystem, it is possible that
# a single transaction that commits right before a power loss might get
# rolled back upon reboot. [...] the last transaction might go missing, thus
# violating durability, if EXTRA is not set."
#
# FULL is the default, not EXTRA. This pair is gray's differential control:
# it must find the loss at FULL and stay quiet at EXTRA. A tool that always
# shouts is as useless as a tool that always stays quiet.
set -eu
sqlite3 "$GRAY_MNT/app.db" "PRAGMA journal_mode=delete; CREATE TABLE t(k TEXT PRIMARY KEY);"
sync
sqlite3 "$GRAY_MNT/app.db" "PRAGMA synchronous=EXTRA; INSERT INTO t VALUES('row1');"
gray ack row1
