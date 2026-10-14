# gray

**Crash-consistency testing for ordinary applications.** Every disk state a power
loss can leave behind, rebuilt on a real block device through `dm-log-writes`,
mounted so the filesystem's own recovery runs, and checked against what your app
said it had already saved — with the missing `fsync` named.

Named after Jim Gray, who wrote down what "saved" is supposed to mean.

---

## The thing it keeps finding

```
$ sudo gray run --workload ./save.sh --check ./verify.sh

Journal: 132 entries, 512-byte sectors
Crash points checked: 23, of them with a promise already made: 17
Skipped before the workload began (mkfs and mount): 5

FAIL — acknowledged data is lost in 3 of 23 checked states.

  crash points #101–#111 after mark "gray:ack:v2"
    acknowledged "v2", found "v1" after recovery

Likely cause
  renameat("…/data.tmp" → "…/data") changes the contents of directory "…",
  and that directory is never fsynced afterwards. A directory entry survives
  power loss only once the directory itself is fsynced — fsyncing the file
  does not cover it.

What the search did not cover
  States at flush boundaries were enumerated. Reorderings inside the window
  between two flushes were not: a drive may commit any subset of the pending
  writes, in any order.
  States left unchecked by that: ~1.1B.
```

That last block is printed on success too. A tool that stays quiet about the
limits of its own search is inviting you to read a green run as proof — the
exact thing this one exists to argue against.

## What the audit found

Twelve targets, the same question asked of each: *the app reported success —
would what it wrote survive the power going out at that moment?*

**Ten of twelve lose an acknowledged write.** The two that do not are the two
controls. Full table and method in [`audit/RESULTS.md`](audit/RESULTS.md).

| | loses | call to blame |
|---|---|---|
| `write-file-atomic@8` — 102M downloads/week, inside the npm CLI | **yes** | `renameat`, directory never fsynced |
| `conf@16` — config store behind hundreds of CLIs | **yes** | `renameat`, directory never fsynced |
| `steno@4` — the writer under lowdb | **yes** | `renameat`, directory never fsynced |
| `git commit`, default settings | **yes** | `renameat`, directory never fsynced |
| `git commit` with `core.fsync=all` | **yes** | `renameat`, directory never fsynced |
| SQLite, `synchronous=FULL` (the default) | **yes** | `unlinkat`, directory never fsynced |
| SQLite, `synchronous=EXTRA` | no | — |
| write + fsync + rename + **directory fsync** | no | — |

None of this is a zero-day. Both SQLite and git document the tradeoff in their
own manuals — SQLite under `PRAGMA synchronous`, git under `core.fsync` — and
in both cases the default is the risky one. gray rediscovered both from block
writes alone, which is the best evidence it works that we have.

**"Loses" does not mean your data always disappears.** It means there is a
window — from the moment the app returned success until the filesystem next
commits its journal — in which the promise has been made and the medium does
not know about it. On ext4 at `commit=5` that window is about five seconds. At
`commit=60`, a tip you will find in a lot of tuning guides, it is about sixty.

## Thirty seconds

```bash
sudo npx @botiroff/gray run \
  --workload 'printf saved > $GRAY_MNT/data && gray ack saved' \
  --check    'test "$(cat $GRAY_MNT/data)" = saved'
```

Needs Linux with `dm-log-writes`, and root. On Ubuntu:

```bash
sudo apt install linux-modules-extra-$(uname -r) dmsetup
sudo modprobe dm-log-writes
```

No Linux box handy? `dev/lima.yaml` brings up a VM that is ready to go,
including on Apple Silicon.

## The contract

Two commands. `--workload` is what your app does; `--check` is what must hold
afterwards.

```bash
sudo gray run --workload ./save.sh --check ./verify.sh
```

Inside `--workload`:

- `$GRAY_MNT` — the directory under test.
- `gray ack <key>` — call this wherever your app would tell a user *saved*.

Inside `--check`:

- `$GRAY_MNT` — the recovered mount, after the filesystem's own journal replay.
- `$GRAY_ACKED` — the keys promised as of this crash point.
- Exit `0` means intact; anything else is a durability violation.

A violation only exists relative to an acknowledgement. Before the first `ack`
every state of the disk is legal, and gray will not let the check complain.
That is why `$GRAY_ACKED` is a list that grows rather than a fixed expectation.

## How it works

```
data.img  ──loop──┐
                  ├── dm-log-writes ── mkfs ── mount   ← your workload runs here
log.img   ──loop──┘        │
                           └── every write, in order, with its barriers

replay.img ──loop── a blank device where one post-crash state is assembled
     │
     └── dm-snapshot ── mounted, which runs the filesystem's own recovery
```

1. The workload runs on a real filesystem on a real block device. `dm-log-writes`
   records every bio with its flush and FUA flags — ground truth from the block
   layer, not a model of it.
2. For each crash point the journal is replayed onto a blank device, producing
   the disk exactly as a power cut would have left it.
3. That device is mounted through a throwaway snapshot, so the filesystem's real
   recovery runs — and so recovery's own writes cannot contaminate the next state.
4. Your check runs against the result.
5. On a finding the workload is traced a second time to name the syscall.

Why a *real* device rather than a model of POSIX: a model tells you about an
idealised machine, a device tells you about yours. `fsync` versus `fdatasync`,
`data=ordered` versus `data=writeback`, ext4 versus xfs, whether your virtual
disk honours a flush at all — none of that is visible to a model, by construction.

## Why you can believe the verdict

- **The parser and the replay are cross-checked against xfstests' `replay-log`.**
  Same journal, byte-identical images across every crash point. gray does not
  depend on xfstests; it just refuses to disagree with it.
- **Two controls that must stay silent** — the correct `rename` recipe, and
  SQLite at `synchronous=EXTRA` — run in the same test suite as the findings.
- **A differential control**: the verdict has to flip on the one knob the
  vendor documents as controlling this behaviour. SQLite at `FULL` loses;
  SQLite at `EXTRA` does not. A tool that always shouts is as useless as one
  that always stays quiet.
- **Two independent replay paths**, fast and `--paranoid`, which must agree.
  They did not, once; the disagreement is how we learned that mounting writes
  to the device. That is now a regression test.

## What it does not cover

- **Reorderings inside the window between two flushes.** States at barriers are
  enumerated; a drive may commit any subset of the pending writes in any order,
  and those states are counted and reported, not checked.
- **Drives that lie about completing a flush.** One of those makes things worse
  than gray reports, never better.
- **`mmap`,** which bypasses the write path gray watches.
- **The oracle is yours.** gray proves that whatever your `--check` asserts
  survives — no more than that.

## Prior art

[CrashMonkey and ACE](https://github.com/utsaslab/crashmonkey) (OSDI '18) and
[ALICE](https://github.com/madthanu/alice) came first and went further on the
research side; both target filesystems rather than applications, and both have
been quiet for years. `dm-log-writes` and the `replay-log` tool it ships with
live in [xfstests](https://github.com/kdave/xfstests) and are built for kernel
developers. gray is the application developer's end of the same idea: point it
at your code, get back the syscall you are missing.

## Requirements

Linux with the `dm-log-writes` and `dm-snapshot` targets, root, Node 22+, and
`strace` if you want the syscall named. Tested on ext4; `--fs xfs` and
`--fs btrfs` run but are not yet measured.

## License

MIT
