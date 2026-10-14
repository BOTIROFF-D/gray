import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import {
  type Bed,
  type Fs,
  blankReplay,
  checkKernelSupport,
  closeSnapshot,
  makeFs,
  mark,
  mount,
  openSnapshot,
  removeDm,
  requireRoot,
  setupBed,
  setupPlain,
  teardownBed,
  teardownPlain,
  umount,
} from './device.ts';
import { type Cause, collectSyscalls, diagnose, readPaths, straceAvailable } from './explain.ts';
import { LOG_FLAG, type LogEntry, type ParsedLog, crashPoints, hasFlag, readLog } from './log.ts';
import { replayRange, replayTo } from './replay.ts';

/** Prefix of the marks `gray ack` uses to record a durability promise. */
export const ACK_PREFIX = 'gray:ack:';

export type RunOptions = {
  workload: string;
  check: string;
  fs: Fs;
  sizeMiB: number;
  mode: 'barriers' | 'all';
  mountOptions?: string;
  work: string;
  /** Check the fast path against a from-scratch replay. Expensive, honest. */
  paranoid: boolean;
  /**
   * How long the machine is assumed to have stayed up after the workload,
   * before the crash being asked about.
   *
   * The question a person asks straight after "you lose data" is "for how long
   * am I exposed", and this answers it. Note what it does: it does not add a
   * pause and keep every earlier crash point — that would change nothing,
   * since those earlier crashes are still possible. It moves the *start* of
   * the enumeration to the end of the pause, so the only states considered are
   * the ones a machine that survived that long could be in.
   *
   * The window is not infinite: the filesystem commits its journal on a timer,
   * and once it has, the promise is real. On ext4 that timer is `commit`, five
   * seconds by default — so `--settle 6` comes back clean where `--settle 0`
   * does not.
   */
  settleSeconds: number;
  onProgress?: ((done: number, total: number) => void) | undefined;
};

export type CrashOutcome = {
  point: number;
  /** The nearest preceding mark — the part a person can act on. */
  after?: string;
  mounted: boolean;
  ok: boolean;
  detail: string;
};

export type RunResult = {
  log: ParsedLog;
  points: number[];
  outcomes: CrashOutcome[];
  failures: CrashOutcome[];
  /** How many crash points fell after something had already been promised. */
  afterFirstAck: number;
  /** Points inside mkfs and mount: nothing to do with the application. */
  skippedBeforeWorkload: number;
  /** Seconds the machine stayed up after the workload, as asked. */
  settleSeconds: number;
  /** What the enumeration left untouched, and how deep the gap goes. */
  notCovered: { subsets: number; maxInFlight: number; capped: boolean; note: string };
  /** The syscalls to blame. Empty when nothing was lost or strace is missing. */
  causes: Cause[];
  /** Why the diagnosis did not run, when it did not. */
  causesSkipped?: string;
  /** The workload never promised anything, so nothing could be violated. */
  nothingPromised: boolean;
  /**
   * Whether the check was shown to be capable of failing.
   *
   * `null` when there was nothing to test it with.
   */
  checkCanFail: boolean | null;
};

/**
 * Drops an executable `gray` next to the rig so the workload can call
 * `gray ack <key>` as an ordinary command.
 *
 * A shim rather than "install the package globally": the workload runs as
 * root, and making someone install a tool system-wide just to try it is a
 * barrier for nothing. The shim also inherits the same interpreter and the
 * same flags gray itself was started with, so it works both from source and
 * from a built package.
 */
function installShim(bed: Bed): string {
  const dir = `${bed.work}/bin`;
  spawnSync('mkdir', ['-p', dir]);
  const self = process.argv[1] ?? '';
  const flags = process.execArgv.map((a) => `'${a}'`).join(' ');
  const path = `${dir}/gray`;
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' ${flags} '${self}' "$@"\n`);
  chmodSync(path, 0o755);
  return dir;
}

function run(cmd: string, env: NodeJS.ProcessEnv): { code: number; out: string } {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/**
 * The keys the application had promised by the time of the crash.
 *
 * A durability violation only exists relative to an acknowledgement: until
 * the application has promised anything, every state of the disk is legal.
 * So the check is handed not "what ought to be there" but "what was promised
 * as of this instant", and before the first ack it has no standing to
 * complain about anything.
 */
function ackedAt(log: ParsedLog, point: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i <= point; i++) {
    const e = log.entries[i];
    if (e && hasFlag(e, LOG_FLAG.MARK) && e.mark?.startsWith(ACK_PREFIX)) {
      keys.push(e.mark.slice(ACK_PREFIX.length));
    }
  }
  return keys;
}

/** The mark in force at this crash point: what the story can be hung on. */
function markBefore(log: ParsedLog, point: number): string | undefined {
  for (let i = point; i >= 0; i--) {
    const e = log.entries[i];
    if (e && hasFlag(e, LOG_FLAG.MARK) && e.mark && !e.mark.startsWith('dm-log-writes')) return e.mark;
  }
  return undefined;
}

/**
 * What the enumeration did NOT cover, counted honestly.
 *
 * Between two flushes a drive may commit any subset of the pending writes, in
 * any order. The barrier mode takes one case per window — the one where every
 * pending write landed. The remaining 2^k − 1 subsets are left out.
 *
 * Two pieces of care in the number, because a number stated loosely is worse
 * than no number:
 *
 *  — These are SUBSETS of in-flight writes, not distinct disk states. Two
 *    different subsets can leave the device byte-identical, so the count is an
 *    upper bound on states and an exact count of subsets. It is reported as
 *    subsets.
 *  — The exponent is capped, because 2^k stops being a number anyone can hold
 *    past a few dozen. When the cap bites, the total is a floor and is
 *    reported as "at least", not "about".
 *
 * `maxInFlight` is the figure actually worth reading: it says how deep the
 * unexplored window gets.
 */
const EXPONENT_CAP = 40;

function uncovered(
  log: ParsedLog,
  points: number[],
  from: number
): { subsets: number; maxInFlight: number; capped: boolean; note: string } {
  let subsets = 0;
  let maxInFlight = 0;
  let capped = false;
  // Counting starts where the workload did. Everything before it is mkfs, and
  // mkfs writes thousands of blocks between flushes — folding those in would
  // report a window the application never had.
  let prev = from - 1;

  for (const p of points) {
    const inFlight = log.entries
      .slice(prev + 1, p)
      .filter((e: LogEntry) => e.nrSectors > 0n && !hasFlag(e, LOG_FLAG.DISCARD)).length;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    if (inFlight > 1) {
      if (inFlight > EXPONENT_CAP) capped = true;
      subsets += 2 ** Math.min(inFlight, EXPONENT_CAP) - 1;
    }
    prev = p;
  }

  return {
    subsets,
    maxInFlight,
    capped,
    note:
      'Cases at flush boundaries were enumerated. Reorderings inside the window ' +
      'between two flushes were not: a drive may commit any subset of the ' +
      'pending writes, in any order.',
  };
}

export function runGray(options: RunOptions): RunResult {
  requireRoot();
  checkKernelSupport();

  const bed: Bed = setupBed(options.work, options.sizeMiB);
  let log: ParsedLog;

  try {
    makeFs(bed, options.fs);
    mount(`/dev/mapper/${bed.dmName}`, bed.mnt, options.mountOptions);

    // "The workload starts here." Everything before it is mkfs and mount,
    // work the application never did. A crash in the middle of mkfs leaves an
    // unmountable volume, and calling that a finding would be crying wolf
    // over nothing.
    mark(bed, 'gray:begin');

    const shimDir = installShim(bed);
    const workloadEnv = {
      GRAY_MNT: bed.mnt,
      GRAY_DM: bed.dmName,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    };
    const w = run(options.workload, workloadEnv);
    if (w.code !== 0) {
      throw new Error(`the workload exited with code ${w.code}:\n${w.out}`);
    }

    // The machine stays up for a while, then the crash we are asking about
    // happens. Everything before `gray:settled` is a crash that came sooner
    // than the question allows.
    if (options.settleSeconds > 0) {
      spawnSync('sleep', [String(options.settleSeconds)]);
      mark(bed, 'gray:settled');
    }

    // End of the workload. The promises themselves are placed by the
    // workload via `gray ack <key>`, wherever it would tell a user "saved".
    mark(bed, 'gray:end');
    umount(bed.mnt);
    removeDm(bed);

    log = readLog(bed.logImage);
  } catch (error) {
    teardownBed(bed);
    throw error;
  }

  const markAt = (name: string) => log.entries.find((e) => hasFlag(e, LOG_FLAG.MARK) && e.mark === name);
  const begin = markAt('gray:begin');
  // With `--settle`, the enumeration starts where the pause ended: a machine
  // that stayed up that long cannot have crashed before it.
  const from = (options.settleSeconds > 0 ? markAt('gray:settled') : undefined) ?? begin;
  const all = crashPoints(log, options.mode);
  const skipped = from ? all.filter((p) => p < from.index).length : 0;
  const points = all.filter((p) => (from ? p >= from.index : true));
  const outcomes: CrashOutcome[] = [];

  /** Every promise the workload made, over the whole run. */
  const allAckedKeys = ackedAt(log, log.entries.length - 1);
  let checkCanFail: boolean | null = null;

  try {
    if (options.paranoid) blankReplay(bed, options.sizeMiB);
    let applied = -1;

    /*
     * Before anything else: can the check fail at all?
     *
     * A check that returns zero no matter what turns every run into a pass,
     * and a pass that could not have been anything else is worth nothing. So
     * it is put in front of the earliest state — the disk as it was when the
     * workload began, before a single promised byte was written — and handed
     * the full list of promises. It has to fail there. If it does not, it is
     * not telling a saved file apart from an empty disk, and every green
     * verdict below it is a property of the check rather than of the code.
     *
     * The same argument as the rest of the tool, turned on the one part of it
     * the user wrote.
     *
     * It runs first, while the target device is still blank: assembling an
     * early state on top of a later one would leave the later one's sectors
     * behind, which is the precise mistake the snapshot exists to prevent.
     */
    const earliest = points[0];
    // The probe only means anything if nothing had been promised yet at that
    // point — otherwise "the disk before a promised byte was written" is not
    // what we would be showing the check. Asserted, not assumed.
    const probeIsValid =
      allAckedKeys.length > 0 && earliest !== undefined && ackedAt(log, earliest).length === 0;

    if (probeIsValid && earliest !== undefined) {
      try {
        replayRange(bed.logImage, log, bed.replayLoop, 0, earliest);
        applied = earliest;
        mount(openSnapshot(bed), bed.replayMnt);
        try {
          const probe = run(options.check, {
            GRAY_MNT: bed.replayMnt,
            GRAY_ACKED: allAckedKeys.join('\n'),
          });
          checkCanFail = probe.code !== 0;
        } finally {
          umount(bed.replayMnt);
          closeSnapshot(bed);
        }
      } catch {
        // The earliest state may legitimately refuse to mount. That says
        // nothing about the check, so the question stays unanswered.
        checkCanFail = null;
      }
    }

    for (const [i, point] of points.entries()) {
      if (options.paranoid) {
        blankReplay(bed, options.sizeMiB);
        replayTo(bed.logImage, log, bed.replayLoop, point);
      } else {
        // Crash points run in increasing order, so only the new entries are
        // shipped: same order, same result, an order of magnitude less work.
        replayRange(bed.logImage, log, bed.replayLoop, applied + 1, point);
        applied = point;
      }

      const after = markBefore(log, point);
      let mounted = false;
      let ok = false;
      let detail = '';

      try {
        // Mount the snapshot, not the assembled state itself: journal
        // recovery writes to the device, and without the snapshot the next
        // crash point would be built on top of someone else's edits.
        mount(openSnapshot(bed), bed.replayMnt);
        mounted = true;
        const c = run(options.check, {
          GRAY_MNT: bed.replayMnt,
          GRAY_ACKED: ackedAt(log, point).join('\n'),
        });
        ok = c.code === 0;
        detail = c.out;
      } catch (error) {
        // A failed mount is a result too: the filesystem did not come back
        // after recovery. That is not a malfunction of the tool.
        detail = `the filesystem would not mount: ${(error as Error).message.split('\n')[0]}`;
      } finally {
        if (mounted) umount(bed.replayMnt);
        closeSnapshot(bed);
      }

      outcomes.push(after === undefined ? { point, mounted, ok, detail } : { point, after, mounted, ok, detail });
      options.onProgress?.(i + 1, points.length);
    }
  } finally {
    teardownBed(bed);
  }

  const failures = outcomes.filter((o) => !o.ok);
  let causes: Cause[] = [];
  let causesSkipped: string | undefined;

  if (failures.length === 0) {
    causesSkipped = undefined;
  } else if (!straceAvailable()) {
    causesSkipped = 'strace is not installed — the offending call was not identified';
  } else {
    // A second run, on a clean filesystem of the same type. Under strace the
    // workload is an order of magnitude slower, and on the real journal that
    // would move the commit timer: the loss would vanish and the report would
    // say all is well.
    try {
      const plain = setupPlain(options.work, Math.min(options.sizeMiB, 128), options.fs, options.mountOptions);
      const calls = collectSyscalls(options.workload, plain, `${options.work}/strace.txt`);
      // A second trace records what the check reads; violations unrelated to
      // the loss are filtered out by it.
      //
      // `GRAY_ACKED` is mandatory: without it the check honestly exits at
      // once without opening a single file, the observed-path set comes back
      // empty, and the filtering does nothing at all.
      const allAcked = ackedAt(log, log.entries.length - 1).join('\n');
      const checkCalls = collectSyscalls(options.check, plain, `${options.work}/strace-check.txt`, {
        GRAY_ACKED: allAcked,
      });
      causes = calls.length === 0 ? [] : diagnose(calls, plain, readPaths(checkCalls, plain));
      if (calls.length === 0) causesSkipped = 'strace produced no output';
    } catch (error) {
      causesSkipped = `diagnosis did not run: ${(error as Error).message.split('\n')[0]}`;
    } finally {
      teardownPlain(options.work);
    }
  }

  return {
    log,
    points,
    outcomes,
    causes,
    ...(causesSkipped === undefined ? {} : { causesSkipped }),
    afterFirstAck: points.filter((p) => ackedAt(log, p).length > 0).length,
    skippedBeforeWorkload: skipped,
    settleSeconds: options.settleSeconds,
    nothingPromised: allAckedKeys.length === 0,
    checkCanFail,
    failures,
    notCovered: uncovered(log, points, from ? from.index : 0),
  };
}
