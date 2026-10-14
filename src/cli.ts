#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import type { Fs } from './device.ts';
import { ACK_PREFIX, type CrashOutcome, type RunResult, runGray } from './run.ts';

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
  --work <dir>          working directory (default /var/tmp/gray)
  --json                machine-readable report

Needs root: device-mapper and loop devices are not reachable otherwise.`;

function human(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  if (n < 1e12) return `${(n / 1e9).toFixed(1)}B`;
  return n.toExponential(1);
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
  if (r.skippedBeforeWorkload > 0) {
    console.log(`Skipped before the workload began (mkfs and mount): ${r.skippedBeforeWorkload}`);
  }
  console.log();

  if (bad === 0) {
    console.log('PASS — the acknowledged data survives every state that was checked.');
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
  if (r.notCovered.reorderings > 0) {
    console.log(`  States left unchecked by that: ~${human(r.notCovered.reorderings)}.`);
  }
}

function main(): void {
  const [, , command, ...rest] = process.argv;

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

  const mountOptions = typeof args['mount-options'] === 'string' ? args['mount-options'] : undefined;
  const result = runGray({
    workload,
    check,
    fs,
    sizeMiB: Number(args.size ?? 256),
    mode: args.mode === 'all' ? 'all' : 'barriers',
    ...(mountOptions === undefined ? {} : { mountOptions }),
    work: typeof args.work === 'string' ? args.work : '/var/tmp/gray',
    paranoid: args.paranoid === true,
    onProgress: args.json
      ? undefined
      : (done, total) => {
          process.stderr.write(`\r  enumerating: ${done}/${total}`);
          if (done === total) process.stderr.write('\n');
        },
  });

  if (args.json) {
    console.log(JSON.stringify({ outcomes: result.outcomes, notCovered: result.notCovered }, null, 2));
  } else {
    report(result);
  }

  process.exit(result.failures.length > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error(`gray: ${(error as Error).message}`);
  process.exit(2);
}
