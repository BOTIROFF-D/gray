# gray

**Crash-consistency testing for ordinary applications.** Every disk state a power
loss can leave behind, rebuilt on a real block device through `dm-log-writes`,
mounted so the filesystem's own recovery runs, and checked against what your app
said it had already saved — with the missing `fsync` named.

[![CI](https://github.com/BOTIROFF-D/gray/actions/workflows/ci.yml/badge.svg)](https://github.com/BOTIROFF-D/gray/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40botiroff%2Fgray)](https://www.npmjs.com/package/@botiroff/gray)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Named after Jim Gray, who wrote down what "saved" is supposed to mean.

---

## The thing it keeps finding

```
$ sudo gray run --workload ./save.sh --check ./verify.sh

Journal: 133 entries, 512-byte sectors
Crash points checked: 24, of them with a promise already made: 18
Skipped before the enumeration starts (mkfs and mount): 5

FAIL — acknowledged data is lost in 3 of 24 checked states.

  crash points #101–#111 after mark "gray:ack:v2"
    acknowledged "v2", found "v1" after recovery

Likely cause
  renameat("…/config.json.tmp" → "…/config.json") changes the contents of
  directory "…", and that directory is never fsynced afterwards. A directory
  entry survives power loss only once the directory itself is fsynced —
  fsyncing the file does not cover it.

What the search did not cover
  Cases at flush boundaries were enumerated. Reorderings inside the window
  between two flushes were not: a drive may commit any subset of the pending
  writes, in any order.
  Deepest window: 13 writes in flight.
  Subsets of them left unenumerated: 9.0 thousand.
```

That last block is printed on success too. A tool that stays quiet about the
limits of its own search is inviting you to read a green run as proof — the
exact thing this one exists to argue against.

## What the audit found

Twelve targets, three filesystems, the same question asked of each: *the app
reported success — would what it wrote survive the power going out at that
moment?*

**Ten of twelve lose an acknowledged write — on ext4, on xfs and on btrfs
alike.** The two that hold are the two controls. Full table, exact versions and
method in [`audit/RESULTS.md`](audit/RESULTS.md).

| | ext4 | xfs | btrfs | call to blame |
|---|---|---|---|---|
| `write-file-atomic@8` — 102M downloads/week, inside the npm CLI | **yes** | **yes** | **yes** | `renameat`, directory never fsynced |
| `conf@16` — config store behind hundreds of CLIs | **yes** | **yes** | **yes** | `renameat`, directory never fsynced |
| `steno@4` — the writer under lowdb | **yes** | **yes** | **yes** | `renameat`, directory never fsynced |
| `git commit`, default settings | **yes** | **yes** | **yes** | `renameat`, directory never fsynced |
| `git commit` with `core.fsync=all` | **yes** | **yes** | **yes** | `renameat`, directory never fsynced |
| SQLite, `synchronous=FULL` (the default) | **yes** | **yes** | **yes** | `unlinkat`, directory never fsynced |
| SQLite, `synchronous=EXTRA` | no | no | no | — |
| write + fsync + rename + **directory fsync** | no | no | no | — |

Three filesystems matter here. A result that only appeared on ext4 would be a
property of ext4, not of the code under test.

One caveat, found the hard way. On this machine xfs loses in ten runs out of
ten. On a busy shared CI runner, one xfs run came back clean and the next one
did not — same commit, same kernel, same `xfsprogs`. The window there is narrow
enough that machine timing decides, and a single run can miss it. We briefly
concluded from that one clean run that xfs held the rename, which was wrong.
This is what `--repeat` is for, and it is the reason a lone green run is not
evidence — including when the tool producing it is this one.

None of this is a zero-day. Both SQLite and git document the tradeoff in their
own manuals — SQLite under `PRAGMA synchronous`, git under `core.fsync` — and
in both cases the default is the risky one. gray rediscovered both from block
writes alone, which is the best evidence it works that we have. What it adds is
that `core.fsync=all`, git's strictest setting, still does not close the window:
it fsyncs the files and never the directories they are renamed into.

**"Loses" does not mean your data always disappears.** It means there is a
window — from the moment the app returned success until the filesystem next
makes that write durable — in which the promise has been made and the medium
does not know about it.

`--settle n` measures it: *if the machine stayed up n seconds after the save,
is the save safe yet?*

```
-- data=ordered,commit=1 --         -- data=ordered,commit=60 --
  survived 0 s  ->  STILL LOSES       survived 0  s  ->  STILL LOSES
  survived 2 s  ->  safe by then      survived 30 s  ->  STILL LOSES
  survived 4 s  ->  safe by then      survived 70 s  ->  safe by then
```

The window is not the page-cache writeback timer everyone expects
(`dirty_expire_centisecs`, thirty seconds). It is the **journal commit
interval**, and it tracks it exactly. Which means `commit=60` — a tip you will
find in plenty of tuning guides — buys throughput by widening the window you
can lose acknowledged data in, by a factor of twelve. `dev/window.sh` sweeps
all three settings and needs nothing but gray.

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

Working pairs to copy from are in [`examples/`](examples): the broken atomic
write and the fixed one side by side, and SQLite at both settings. Everything
the audit measured is in [`audit/targets/`](audit/targets), one directory per
target, and `sudo node --experimental-strip-types audit/run.ts` re-runs the
whole table.

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

Exit status is `0` when nothing was lost, `1` when something was, `2` when gray
could not run — so it drops into CI as it is.

### How long am I exposed?

```bash
sudo gray run --workload ./save.sh --check ./verify.sh --settle 7
```

`--settle n` drops every crash that would have happened sooner than n seconds
after the workload, and enumerates only the rest. It answers the question that
comes right after "you lose data", and it is how the table above was measured.

### When the workload does not do the same thing twice

gray's verdict comes from one execution of your workload, and the states it can
enumerate are the ones that execution produced. A workload whose timing wanders
can present a different journal next time and hide the loss. `--repeat n` runs
the whole thing n times and says plainly whether the verdict held:

```
Repeated 5 times: THE VERDICT VARIED — losses per run: 3, 0, 3, 3, 0.
  Your workload does not do the same thing twice, so a single run of
  gray cannot settle it. The highest count above is the one to believe:
  a loss seen once is a loss, a run that missed it proves nothing.
```

## It refuses to hand you a meaningless pass

Two ways a crash-consistency tool can quietly lie, both of which gray checks on
itself before it checks on you:

**The workload never promised anything.** No `gray ack`, so `$GRAY_ACKED` is
empty in every check, every check exits zero, and a naive tool prints PASS.

```
INCONCLUSIVE — the workload never called `gray ack`.
  Nothing was promised, so nothing could be violated and $GRAY_ACKED was
  empty in every check. This run proves nothing about durability.
```

**The check cannot fail.** Before enumerating anything, gray puts your check in
front of the disk as it was *before the workload wrote a byte*, and hands it the
full list of promises. It has to fail there. If it does not, it is not telling a
saved file apart from an empty one:

```
INCONCLUSIVE — the check cannot fail.
  It returns success even on the disk as it was before the workload wrote
  anything, with every promised key handed to it. It is not telling a
  saved file apart from an empty one, so its silence means nothing.
```

Both exit `2`, not `0`, so neither can slip through CI as a green build. A pass
that could not have been anything else is worth less than an error.

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
- **Two enumeration modes** — flush boundaries and every single write — which
  must agree on whether anything is lost, differing only in resolution.
- **Its own verdict must not wander.** Repeated runs of the same workload have
  to reach the same answer. A tool whose output drifts between runs is the
  thing this one was written to catch.
- **It will not report a pass it could not have failed**, as above.
- **Every claim above is an assertion in `test/run.ts`**, which runs on ext4,
  xfs and btrfs. Thirty-one of them, and the findings are tested alongside the
  controls rather than in a separate suite that nobody runs.

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
`strace` if you want the syscall named. Measured on ext4, xfs and btrfs;
the full audit runs on all three.

## License

MIT
