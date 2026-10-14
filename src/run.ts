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
  /** How many disk states the enumeration left untouched. */
  notCovered: { reorderings: number; note: string };
  /** The syscalls to blame. Empty when nothing was lost or strace is missing. */
  causes: Cause[];
  /** Why the diagnosis did not run, when it did not. */
  causesSkipped?: string;
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
 * How many disk states the enumeration did NOT cover.
 *
 * Between two flushes a drive may commit any subset of the pending writes in
 * any order. The barrier mode takes one state per window — the one where
 * everything landed. The other 2^k − 1 are left out, and the tool is obliged
 * to say that number out loud rather than pass over it. Otherwise it becomes
 * the very thing it was written against: a green run passing itself off as
 * proof.
 */
function uncovered(log: ParsedLog, points: number[]): { reorderings: number; note: string } {
  let total = 0;
  let prev = -1;
  for (const p of points) {
    const inFlight = log.entries
      .slice(prev + 1, p)
      .filter((e: LogEntry) => e.nrSectors > 0n && !hasFlag(e, LOG_FLAG.DISCARD)).length;
    if (inFlight > 1) total += Math.max(0, 2 ** Math.min(inFlight, 30) - 1);
    prev = p;
  }
  return {
    reorderings: total,
    note:
      'States at flush boundaries were enumerated. Reorderings inside the window ' +
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

  const begin = log.entries.find((e) => hasFlag(e, LOG_FLAG.MARK) && e.mark === 'gray:begin');
  const skipped = begin ? crashPoints(log, options.mode).filter((p) => p < begin.index).length : 0;
  const points = crashPoints(log, options.mode).filter((p) => (begin ? p >= begin.index : true));
  const outcomes: CrashOutcome[] = [];

  try {
    if (options.paranoid) blankReplay(bed, options.sizeMiB);
    let applied = -1;

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
    failures,
    notCovered: uncovered(log, points),
  };
}
