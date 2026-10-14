# Durability audit

Measured 2026-10-14 on kernel 6.8.0-142-generic, ext4 `data=ordered,commit=5`, device under `dm-log-writes`.

Every target is asked the same question: the app reported success — would what it wrote survive the power going out at that moment?

**Targets measured: 12. Losing an acknowledged write: 10.**

| target | what it is | loses | states | call to blame |
|---|---|---|---|---|
| `atomically` | atomically@2 — the engine under conf | **yes** | 3 of 23 | renameat, directory never fsynced |
| `conf` | conf@16 — config store behind hundreds of CLIs | **yes** | 3 of 23 | renameat, directory never fsynced |
| `fs-writefile` | fs.writeFileSync, no sync at all | **yes** | 3 of 14 | write with no fsync |
| `git-commit` | git commit, default settings | **yes** | 5 of 23 | renameat, directory never fsynced |
| `git-commit-fsync` | git commit with core.fsync=all | **yes** | 3 of 51 | renameat, directory never fsynced |
| `npm-pkg-set` | npm pkg set — editing package.json | **yes** | 3 of 19 | write with no fsync |
| `rename-fsync-dir` | the same plus a directory fsync (control) | no | 0 of 24 | — |
| `rename-nofsync` | write + fsync + rename, no directory fsync | **yes** | 3 of 23 | renameat, directory never fsynced |
| `steno` | steno@4 — the writer under lowdb | **yes** | 3 of 19 | renameat, directory never fsynced |
| `write-file-atomic` | write-file-atomic@8 — 102M downloads a week | **yes** | 3 of 24 | renameat, directory never fsynced |
| `sqlite-full` | SQLite, synchronous=FULL (the default) | **yes** | 3 of 30 | unlinkat, directory never fsynced |
| `sqlite-extra` | SQLite, synchronous=EXTRA | no | 0 of 31 | — |

## What "loses" means here

Not "your data always disappears". There is a window — from the moment the app
returned success until the filesystem next commits its journal — in which the
promise has been made and the medium does not know about it. At `commit=5` that
window is about five seconds. At `commit=60`, a common performance tip, it is
about sixty.

## What the audit does not cover

- Reorderings inside the window between two flushes: states at flush boundaries were enumerated.
- Drives that lie about completing a flush. One of those makes things worse, not better.
- ext4 only. xfs and btrfs have their own machinery and need their own measurement.
