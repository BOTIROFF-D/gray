/**
 * The audit: one question asked of every target.
 *
 * "The app said saved. Would that survive the power going out right then?"
 *
 * Three rules decide whether the table is worth believing:
 *
 *  — The denominator is always printed. "We found losses in four" without
 *    "out of how many" is an anecdote, not a measurement.
 *  — The controls sit in the same table, not off to one side. If the tool
 *    stays quiet on the correct recipe and on SQLite at EXTRA, then its noise
 *    on everything else means something; if it shouted at all of them the
 *    table would be worthless.
 *  — No row is filled in from documentation or from reading source. Only from
 *    a run.
 *
 * Usage (needs root and a kernel with dm-log-writes):
 *   sudo node --experimental-strip-types audit/run.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src/cli.ts');
const targetsDir = join(root, 'audit/targets');

type Row = {
  name: string;
  title: string;
  losses: number;
  checked: number;
  cause: string;
  error?: string;
};

function runTarget(workload: string, check: string): Omit<Row, 'name' | 'title'> {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cli, 'run',
     '--workload', workload, '--check', check,
     '--mount-options', 'data=ordered,commit=5', '--size', '256'],
    { encoding: 'utf8', cwd: root, timeout: 15 * 60 * 1000 }
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  if (r.status === 2) {
    return {
      losses: -1,
      checked: 0,
      cause: '',
      error: out.split('\n').find((l) => l.startsWith('gray:')) ?? 'failed to run',
    };
  }

  const loss = out.match(/lost in (\d+) of (\d+)/);
  const checked = loss ? Number(loss[2]) : Number(out.match(/Crash points checked: (\d+)/)?.[1] ?? 0);

  // Only the gist of the cause fits a table cell: the call and whether the
  // directory was left unsynced.
  const causeLine = out.split('\n').find((l) => /^ {2}(\w+\(|the write to )/.test(l))?.trim() ?? '';
  const call = causeLine.match(/^(\w+)\(/)?.[1] ?? '';
  const cause = call
    ? /never fsynced/.test(causeLine)
      ? `${call}, directory never fsynced`
      : call
    : /^the write to/.test(causeLine)
      ? 'write with no fsync'
      : '';

  return { losses: loss ? Number(loss[1]) : 0, checked, cause };
}

const names = readdirSync(targetsDir).filter((n) => existsSync(join(targetsDir, n, 'workload.sh'))).sort();

// The SQLite pair lives in examples/ but belongs in this table: a reader needs
// to see that the tool does not simply shout at everything it is pointed at.
const extra = [
  { name: 'sqlite-full', title: 'SQLite, synchronous=FULL (the default)', w: 'examples/sqlite/workload.sh', c: 'examples/sqlite/check.sh' },
  { name: 'sqlite-extra', title: 'SQLite, synchronous=EXTRA', w: 'examples/sqlite/workload-extra.sh', c: 'examples/sqlite/check.sh' },
];

const rows: Row[] = [];
const say = (res: Omit<Row, 'name' | 'title'>) =>
  process.stderr.write(res.error ? 'failed\n' : res.losses > 0 ? `loses (${res.losses}/${res.checked})\n` : `intact (0/${res.checked})\n`);

for (const name of names) {
  const dir = join(targetsDir, name);
  const title = readFileSync(join(dir, 'title.txt'), 'utf8').trim();
  process.stderr.write(`  ${name} … `);
  const res = runTarget(join(dir, 'workload.sh'), join(dir, 'check.sh'));
  rows.push({ name, title, ...res });
  say(res);
}

for (const e of extra) {
  process.stderr.write(`  ${e.name} … `);
  const res = runTarget(join(root, e.w), join(root, e.c));
  rows.push({ name: e.name, title: e.title, ...res });
  say(res);
}

const ok = rows.filter((r) => !r.error);
const lost = ok.filter((r) => r.losses > 0);
const kernel = spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim();

const lines: string[] = [];
lines.push('# Durability audit');
lines.push('');
lines.push(`Measured ${new Date().toISOString().slice(0, 10)} on kernel ${kernel}, ext4 \`data=ordered,commit=5\`, ` +
  'device under `dm-log-writes`.');
lines.push('');
lines.push('Every target is asked the same question: the app reported success — would what it wrote survive the power going out at that moment?');
lines.push('');
lines.push(`**Targets measured: ${ok.length}. Losing an acknowledged write: ${lost.length}.**`);
lines.push('');
lines.push('| target | what it is | loses | states | call to blame |');
lines.push('|---|---|---|---|---|');
for (const r of rows) {
  if (r.error) {
    lines.push(`| \`${r.name}\` | ${r.title} | — | — | did not run: ${r.error} |`);
    continue;
  }
  lines.push(`| \`${r.name}\` | ${r.title} | ${r.losses > 0 ? '**yes**' : 'no'} | ${r.losses} of ${r.checked} | ${r.cause || '—'} |`);
}
lines.push('');
lines.push('## What "loses" means here');
lines.push('');
lines.push('Not "your data always disappears". There is a window — from the moment the app');
lines.push('returned success until the filesystem next commits its journal — in which the');
lines.push('promise has been made and the medium does not know about it. At `commit=5` that');
lines.push('window is about five seconds. At `commit=60`, a common performance tip, it is');
lines.push('about sixty.');
lines.push('');
lines.push('## What the audit does not cover');
lines.push('');
lines.push('- Reorderings inside the window between two flushes: states at flush boundaries were enumerated.');
lines.push('- Drives that lie about completing a flush. One of those makes things worse, not better.');
lines.push('- ext4 only. xfs and btrfs have their own machinery and need their own measurement.');

const report = `${lines.join('\n')}\n`;
writeFileSync(join(root, 'audit/RESULTS.md'), report);
console.log();
console.log(report);
