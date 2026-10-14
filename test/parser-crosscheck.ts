/**
 * Cross-checking our journal parser against the reference from xfstests.
 *
 * We need our own parser: dragging along a C compiler and a clone of xfstests
 * to read twenty-eight bytes of header is a bad trade for a tool people
 * install with one command. But a parser written from a description owes
 * agreement to the one that has been reading these journals for years.
 *
 * Two things are compared: how many entries the journal holds, and which
 * entry numbers the marks sit on. A disagreement in either means we have
 * drifted from the format.
 */
import { execFileSync } from 'node:child_process';
import { LOG_FLAG, crashPoints, flagsToString, hasFlag, readLog } from '../src/log.ts';

const journal = process.argv[2] ?? '/var/tmp/gray-log/journal.bin';
const reference = process.argv[3] ?? `${process.env.HOME}/ref/replay-log`;

const ref = (args: string[]) =>
  execFileSync(reference, ['--log', journal, ...args], { encoding: 'utf8' }).trim();

const log = readLog(journal);
let failures = 0;
const check = (name: string, mine: unknown, theirs: unknown) => {
  const ok = String(mine) === String(theirs);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok' : 'XX'} ${name}: ours ${mine} · reference ${theirs}`);
};

console.log(`journal: ${journal}`);
console.log(
  `sector: ${log.sectorSize}B · entries read: ${log.entries.length}${log.truncated ? ' (TRUNCATED)' : ''}`
);
console.log();

console.log('-- entry count --');
const refCount = ref(['--num-entries']).replace(/\D+/g, '');
check('total', log.entries.length, refCount);

console.log();
console.log('-- mark positions --');
const marks = log.entries.filter((e) => hasFlag(e, LOG_FLAG.MARK) && e.mark);
if (marks.length === 0) {
  failures++;
  console.log('  XX no marks found at all — the parser cannot see them');
}
for (const m of marks) {
  // `--find --end-mark` prints the entry number the mark sits on.
  const theirs = ref(['--find', '--end-mark', m.mark!]).match(/(\d+)/)?.[1];
  check(`"${m.mark}"`, m.index, theirs);
}

console.log();
console.log('-- crash points --');
const barriers = crashPoints(log, 'barriers');
console.log(`  barriers (FLUSH|FUA|MARK): ${barriers.length} of ${log.entries.length} entries`);
const count = (flag: number) => log.entries.filter((e) => hasFlag(e, flag)).length;
console.log(
  `  FLUSH ${count(LOG_FLAG.FLUSH)} · FUA ${count(LOG_FLAG.FUA)} · ` +
    `METADATA ${count(LOG_FLAG.METADATA)} · MARK ${marks.length}`
);

console.log();
console.log('-- first entries --');
for (const e of log.entries.slice(0, 6)) {
  console.log(
    `  #${String(e.index).padStart(4)} sector ${String(e.sector).padStart(9)} ` +
      `x${String(e.nrSectors).padStart(4)}  ${flagsToString(e.flags)}${e.mark ? `  "${e.mark}"` : ''}`
  );
}

console.log();
console.log(failures === 0 ? 'CROSS-CHECK PASSED' : `CROSS-CHECK FAILED: ${failures} disagreements`);
process.exit(failures === 0 ? 0 : 1);
