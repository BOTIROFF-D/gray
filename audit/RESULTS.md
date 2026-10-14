# Durability audit

Measured 2026-10-14 on kernel 6.8.0-142-generic aarch64, device under `dm-log-writes`.

Every target is asked the same question: the app reported success — would what it wrote survive the power going out at that moment?

**Targets measured: 12. Losing an acknowledged write on at least one filesystem: 10.**

| target | what it is | ext4 | xfs | btrfs | call to blame |
|---|---|---|---|---|---|
| `atomically` | atomically@2 — the engine under conf | **yes** (3/21) | **yes** (3/17) | **yes** (3/12) | `renameat`, directory never fsynced |
| `conf` | conf@16 — config store behind hundreds of CLIs | **yes** (3/23) | **yes** (3/21) | **yes** (3/14) | `renameat`, directory never fsynced |
| `fs-writefile` | fs.writeFileSync, no sync at all | **yes** (3/14) | **yes** (3/13) | **yes** (3/8) | write with no `fsync` |
| `git-commit` | git commit, default settings | **yes** (5/23) | **yes** (3/16) | **yes** (3/10) | `renameat`, directory never fsynced |
| `git-commit-fsync` | git commit with core.fsync=all | **yes** (3/51) | **yes** (3/39) | **yes** (3/34) | `renameat`, directory never fsynced |
| `npm-pkg-set` | npm pkg set — editing package.json | **yes** (3/19) | **yes** (3/15) | **yes** (3/10) | write with no `fsync` |
| `rename-fsync-dir` | the same plus a directory fsync (control) | no (0/22) | no (0/19) | no (0/14) | — |
| `rename-nofsync` | write + fsync + rename, no directory fsync | **yes** (3/21) | **yes** (3/17) | **yes** (3/12) | `renameat`, directory never fsynced |
| `steno` | steno@4 — the writer under lowdb | **yes** (3/19) | **yes** (3/15) | **yes** (3/10) | `renameat`, directory never fsynced |
| `write-file-atomic` | write-file-atomic@8 — 102M downloads a week | **yes** (3/21) | **yes** (3/17) | **yes** (3/12) | `renameat`, directory never fsynced |
| `sqlite-full` | SQLite, `synchronous=FULL` (the default) | **yes** (3/28) | **yes** (3/26) | **yes** (3/26) | `unlinkat`, directory never fsynced |
| `sqlite-extra` | SQLite, `synchronous=EXTRA` | no (0/29) | no (0/26) | no (0/28) | — |

Cells read `losses / crash points checked`. ext4 runs at `data=ordered,commit=5`; xfs and btrfs run at their defaults, which is what their users run.

## The two controls

`rename-fsync-dir` and `sqlite-extra` are here to be disbelieved. They are the
cases that are known to be right, and gray has to stay quiet on them — on every
filesystem, not just the convenient one. It does. A false alarm on btrfs alone
would void the btrfs column, and with it the claim that this is not an ext4 quirk.

The SQLite pair goes further: the verdict has to **flip** on the one knob the
vendor documents as controlling this behaviour. `FULL` loses on all three
filesystems, `EXTRA` loses on none.

## What "loses" means here

Not "your data always disappears". There is a window — from the moment the app
returned success until the filesystem next makes that write durable — in which
the promise has been made and the medium does not know about it. On ext4 at
`commit=5` the window is about five seconds; at `commit=60`, a tip you will find
in plenty of tuning guides, it is about sixty. See `dev/window.sh`.

## Versions under test

| | version |
|---|---|
| `write-file-atomic` | 8.0.0 |
| `atomically` | 2.1.1 |
| `conf` | 16.0.0 |
| `steno` | 4.0.2 |
| `git` | 2.43.0 |
| `sqlite3` | 3.45.1 |
| `npm` | 10.9.4 |
| `node` | 22.21.1 |

## What the audit does not cover

- Reorderings inside the window between two flushes. Cases at flush boundaries
  were enumerated; the subsets left out are counted and reported by every run.
  btrfs flushes far less often than ext4, so its windows are far deeper and its
  column is the least complete of the three.
- Drives that lie about completing a flush. One of those makes things worse than
  this table says, never better.
- `mmap`, which bypasses the write path gray watches.
- One architecture, one kernel. Both are printed above so the run can be repeated.
