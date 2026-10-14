#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Fs } from './device.ts';
import { ACK_PREFIX, type CrashOutcome, type RunOptions, type RunResult, runGray } from './run.ts';

/**
 * Arguments parsed by hand. One dependency in a tool you are asked to run as
 * root is one dependency you are asked to run as root.
 */
function parse(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const USAGE = `gray — prove by enumeration whether your app survives power loss

  sudo gray run --workload <cmd> --check <cmd> [options]
  gray ack <key>         mark a durability promise (called from --workload)
  gray mark <name>       a plain named mark in the journal
  gray --version

Required
  --workload <cmd>   what your app does. The directory under test is $GRAY_MNT
  --check <cmd>      what must hold after recovery. $GRAY_MNT is the recovered
                     mount, $GRAY_ACKED lists the keys promised as of this
                     crash point. Exit 0 means intact, anything else is a
                     durability violation

Options
  --fs ext4|xfs|btrfs   filesystem under test (default ext4)
  --mount-options <..>  mount options, e.g. data=ordered,commit=5
  --size <MiB>          device size (default 256)
  --mode barriers|all   crash points: flush boundaries, or every single write
  --paranoid            rebuild every state from scratch instead of trusting
                        the incremental path
  --repeat <n>          run the whole thing n times and report whether the
                        verdict held. A workload whose timing varies can hide
                        a loss from a single run
  --settle <seconds>    only consider crashes that happen at least this long
                        after the workload. Answers "I stayed up n seconds —
                        am I safe yet?"; the window closes when the filesystem
                        next commits its journal
  --work <dir>          working directory (default /var/tmp/gray)
  --json                machine-readable report

Exit status
  0  nothing lost in any state that was checked
  1  acknowledged data was lost
  2  gray could not run, or the run proved nothing

Needs root: device-mapper and loop devices are not reachable otherwise.`;

function human(n: number): string {
  const units: [number, string][] = [
    [1e15, 'quadrillion'],
    [1e12, 'trillion'],
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ];
  for (const [scale, name] of units) {
    if (n >= scale) return `${(n / scale).toFixed(1)} ${name}`;
  }
  return String(Math.round(n));
}

/** Collapses a run of consecutive failures: a hundred lines about one bug is noise. */
function windows(outcomes: CrashOutcome[]): { from: CrashOutcome; to: CrashOutcome; count: number }[] {
  const result: { from: CrashOutcome; to: CrashOutcome; count: number }[] = [];
  let current: { from: CrashOutcome; to: CrashOutcome; count: number } | null = null;
  for (const o of outcomes) {
    if (!o.ok) {
      if (current) {
        current.to = o;
        current.count++;
      } else {
        current = { from: o, to: o, count: 1 };
      }
    } else if (current) {
      result.push(current);
      current = null;
    }
  }
  if (current) result.push(current);
  return result;
}

function report(r: RunResult): void {
  const total = r.points.length;
  const bad = r.failures.length;

  console.log();
  console.log(`Journal: ${r.log.entries.length} entries, ${r.log.sectorSize}-byte sectors`);
  console.log(`Crash points checked: ${total}, of them with a promise already made: ${r.afterFirstAck}`);
  if (r.settleSeconds > 0) {
    console.log(`Only crashes at least ${r.settleSeconds}s after the workload were considered.`);
  }
  if (r.skippedBeforeWorkload > 0) {
    const why = r.settleSeconds > 0 ? 'mkfs, mount and the settle period' : 'mkfs and mount';
    console.log(`Skipped before the enumeration starts (${why}): ${r.skippedBeforeWorkload}`);
  }
  console.log();

  if (bad === 0 && r.nothingPromised) {
    // A pass with nothing promised is not a pass. The workload never said
    // "saved", so there was no promise to break, and $GRAY_ACKED was empty in
    // every check. Printing PASS here would be the tool telling the exact lie
    // it was built to catch.
    console.log('INCONCLUSIVE — the workload never called `gray ack`.');
    console.log('  Nothing was promised, so nothing could be violated and $GRAY_ACKED was');
    console.log('  empty in every check. This run proves nothing about durability.');
  } else if (bad === 0 && r.checkCanFail === false) {
    console.log('INCONCLUSIVE — the check cannot fail.');
    console.log('  It returns success even on the disk as it was before the workload wrote');
    console.log('  anything, with every promised key handed to it. It is not telling a');
    console.log('  saved file apart from an empty one, so its silence means nothing.');
  } else if (bad === 0) {
    console.log('PASS — the acknowledged data survives every state that was checked.');
    if (r.checkCanFail === null) {
      console.log('  (Could not confirm the check is able to fail — the earliest state');
      console.log('  would not mount, so that question stays open.)');
    }
  } else {
    console.log(`FAIL — acknowledged data is lost in ${bad} of ${total} checked states.`);
    console.log();
    for (const w of windows(r.outcomes)) {
      const where = w.from.after ? ` after mark "${w.from.after}"` : '';
      const range = w.count === 1 ? `crash point #${w.from.point}` : `crash points #${w.from.point}–#${w.to.point}`;
      console.log(`  ${range}${where}`);
      const detail = w.from.detail.split('\n')[0];
      if (detail) console.log(`    ${detail}`);
      if (!w.from.mounted) console.log('    the filesystem would not mount');
    }
  }

  if (r.causes.length > 0) {
    console.log();
    console.log('Likely cause');
    for (const c of r.causes.slice(0, 3)) console.log(`  ${c.explanation}`);
    if (r.causes.length > 3) {
      console.log(`  …and ${r.causes.length - 3} more: the workload breaks the rule in several places.`);
    }
  } else if (r.causesSkipped && bad > 0) {
    console.log();
    console.log(`Likely cause: ${r.causesSkipped}`);
  }

  // Printed every time, including on success. A tool that stays quiet about
  // the limits of its own search is inviting you to read a green run as proof
  // — the exact thing this tool exists to argue against.
  console.log();
  console.log('What the search did not cover');
  console.log(`  ${r.notCovered.note}`);
  if (r.notCovered.maxInFlight > 1) {
    const { subsets, maxInFlight, capped } = r.notCovered;
    const howMany = capped ? `at least ${human(subsets)}` : human(subsets);
    console.log(`  Deepest window: ${maxInFlight} writes in flight.`);
    console.log(`  Subsets of them left unenumerated: ${howMany}.`);
  }
}

function main(): void {
  const [, , command, ...rest] = process.argv;

  if (command === '--version' || command === '-v') {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string };
    console.log(manifest.version);
    return;
  }

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  if (command === 'ack' || command === 'mark') {
    const raw = rest[0];
    const name = command === 'ack' && raw ? `${ACK_PREFIX}${raw}` : raw;
    const dm = process.env.GRAY_DM;
    if (!name) throw new Error(`gray ${command}: no name given`);
    if (!dm) throw new Error(`gray ${command}: GRAY_DM is unset — call this from inside --workload`);
    execFileSync('dmsetup', ['message', dm, '0', 'mark', name]);
    return;
  }

  if (command !== 'run') {
    console.error(`unknown command: ${command}`);
    console.log(USAGE);
    process.exit(1);
  }

  const args = parse(rest);
  const workload = args.workload;
  const check = args.check;
  if (typeof workload !== 'string' || typeof check !== 'string') {
    console.error('--workload and --check are both required');
    console.log();
    console.log(USAGE);
    process.exit(1);
  }

  const fs = (typeof args.fs === 'string' ? args.fs : 'ext4') as Fs;
  if (!['ext4', 'xfs', 'btrfs'].includes(fs)) {
    console.error(`unknown filesystem: ${fs}`);
    process.exit(1);
  }

  const repeat = Math.max(1, Number(args.repeat ?? 1));
  const mountOptions = typeof args['mount-options'] === 'string' ? args['mount-options'] : undefined;
  const options: RunOptions = {
    workload,
    check,
    fs,
    sizeMiB: Number(args.size ?? 256),
    mode: args.mode === 'all' ? 'all' : 'barriers',
    ...(mountOptions === undefined ? {} : { mountOptions }),
    work: typeof args.work === 'string' ? args.work : '/var/tmp/gray',
    paranoid: args.paranoid === true,
    settleSeconds: Math.max(0, Number(args.settle ?? 0)),
    onProgress: args.json
      ? undefined
      : (done: number, total: number) => {
          process.stderr.write(`\r  enumerating: ${done}/${total}`);
          if (done === total) process.stderr.write('\n');
        },
  };

  /*
   * Repeating is not belt and braces, it is the point.
   *
   * gray's verdict is taken from one execution of your workload, and the
   * states it can enumerate are the ones that execution produced. A workload
   * whose timing wanders — a background flush landing earlier, a commit timer
   * firing sooner — can present a different journal next time and hide the
   * loss. One green run settles nothing; that is the argument this whole tool
   * is built on, and it applies to the tool itself.
   */
  const runs: RunResult[] = [];
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1 && !args.json) process.stderr.write(`run ${i + 1} of ${repeat}\n`);
    runs.push(runGray(options));
  }

  // Report the run that found something, if any did: a loss seen once is a
  // loss, and showing the quiet run instead would bury it.
  const shown = runs.find((r) => r.failures.length > 0) ?? runs[0]!;
  const lossCounts = runs.map((r) => r.failures.length);
  const stable = lossCounts.every((n) => n === lossCounts[0]);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          losses: shown.failures.length,
          checked: shown.points.length,
          nothingPromised: shown.nothingPromised,
          checkCanFail: shown.checkCanFail,
          outcomes: shown.outcomes,
          causes: shown.causes,
          notCovered: shown.notCovered,
          ...(repeat > 1 ? { repeat, lossCounts, stable } : {}),
        },
        null,
        2
      )
    );
  } else {
    report(shown);
    if (repeat > 1) {
      console.log();
      if (stable) {
        console.log(`Repeated ${repeat} times: the same verdict every time.`);
      } else {
        console.log(`Repeated ${repeat} times: THE VERDICT VARIED — losses per run: ${lossCounts.join(', ')}.`);
        console.log('  Your workload does not do the same thing twice, so a single run of');
        console.log('  gray cannot settle it. The highest count above is the one to believe:');
        console.log('  a loss seen once is a loss, a run that missed it proves nothing.');
      }
    }
  }

  // An inconclusive run must not look green in CI: a pass that could not have
  // been anything else is worth less than an error.
  const inconclusive = shown.nothingPromised || shown.checkCanFail === false;
  process.exit(Math.max(...lossCounts) > 0 ? 1 : inconclusive ? 2 : 0);
}

try {
  main();
} catch (error) {
  console.error(`gray: ${(error as Error).message}`);
  process.exit(2);
}
