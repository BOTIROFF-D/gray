#!/bin/sh
# SQLite at its default settings: journal_mode=delete, synchronous=FULL.
#
# Deleting the rollback journal is the commit point. SQLite fsyncs the
# directory when it CREATES that journal and not when it removes it, so a
# crash right after the commit can bring the journal back and roll the
# transaction away. SQLite documents this under PRAGMA synchronous.
set -eu
sqlite3 "$GRAY_MNT/app.db" "PRAGMA journal_mode=delete; CREATE TABLE t(k TEXT PRIMARY KEY);"
sync
sqlite3 "$GRAY_MNT/app.db" "INSERT INTO t VALUES('row1');"
gray ack row1
