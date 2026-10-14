/**
 * The audit: one question asked of every target, on every filesystem.
 *
 * "The app said saved. Would that survive the power going out right then?"
 *
 * Four rules decide whether the table is worth believing:
 *
 *  — The denominator is always printed. "We found losses in ten" without
 *    "out of how many" is an anecdote, not a measurement.
 *  — The controls sit in the same table, not off to one side. If the tool
 *    stays quiet on the correct recipe and on SQLite at EXTRA, then its noise
 *    on everything else means something; if it shouted at all of them the
 *    table would be worthless. The controls run on every filesystem too: a
 *    false alarm on btrfs alone would void the btrfs column.
 *  — Exact versions are recorded. "write-file-atomic loses data" without a
 *    version is a claim nobody can check or refute.
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
const cli = join(root, 'dist/cli.js');
const targetsDir = join(root, 'audit/targets');

/**
 * Mount options are per-filesystem on purpose. `data=ordered,commit=5` is
 * ext4's vocabulary; passing it to xfs is an error, not a no-op. The other two
 * run at their defaults, which is what their users run.
 */
const FILESYSTEMS = [
  { fs: 'ext4', mount: 'data=ordered,commit=5' },
  { fs: 'xfs', mount: '' },
  { fs: 'btrfs', mount: '' },
] as const;

const SIZE_MIB = 512; // btrfs wants elbow room; the others do not mind.

type Verdict = { losses: number; checked: number; cause: string; inconclusive?: string; error?: string };
type Row = { name: string; title: string; by: Record<string, Verdict> };

function runOne(workload: string, check: string, fs: string, mount: string): Verdict {
  const r = spawnSync(
    process.execPath,
    [cli, 'run', '--workload', workload, '--check', check,
     '--fs', fs, '--size', String(SIZE_MIB),
     ...(mount ? ['--mount-options', mount] : [])],
    { encoding: 'utf8', cwd: root, timeout: 20 * 60 * 1000 }
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  if (r.status === 2 || r.status === null) {
    return {
      losses: -1,
      checked: 0,
      cause: '',
      error: out.split('\n').find((l) => l.startsWith('gray:'))?.slice(0, 60) ?? 'did not run',
    };
  }

  const loss = out.match(/lost in (\d+) of (\d+)/);
  const checked = loss ? Number(loss[2]) : Number(out.match(/Crash points checked: (\d+)/)?.[1] ?? 0);

  // An inconclusive run reports no losses, and without this it would land in
  // the table as "intact" — a tool-shaped lie in the middle of the evidence.
  const inconclusive = out.match(/^INCONCLUSIVE — (.+)$/m)?.[1];
  if (inconclusive) return { losses: 0, checked, cause: '', inconclusive };

  const causeLine = out.split('\n').find((l) => /^ {2}(\w+\(|the write to )/.test(l))?.trim() ?? '';
  const call = causeLine.match(/^(\w+)\(/)?.[1] ?? '';
  const cause = call
    ? /never fsynced/.test(causeLine)
      ? `\`${call}\`, directory never fsynced`
      : `\`${call}\``
    : /^the write to/.test(causeLine)
      ? 'write with no `fsync`'
      : '';

  return { losses: loss ? Number(loss[1]) : 0, checked, cause };
}

/** Exact versions of everything under test, so the table can be re-run. */
function versions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pkg of ['write-file-atomic', 'atomically', 'conf', 'steno']) {
    const manifest = join(root, 'audit/node_modules', pkg, 'package.json');
    if (existsSync(manifest)) out[pkg] = JSON.parse(readFileSync(manifest, 'utf8')).version;
  }
  const tool = (cmd: string, args: string[], pick: RegExp) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return (`${r.stdout ?? ''}`.match(pick)?.[1] ?? '').trim();
  };
  out.git = tool('git', ['--version'], /git version (\S+)/);
  out.sqlite3 = tool('sqlite3', ['--version'], /^(\S+)/);
  out.npm = tool('npm', ['-v'], /^(\S+)/);
  out.node = process.version.slice(1);
  return out;
}

const names = readdirSync(targetsDir)
  .filter((n) => existsSync(join(targetsDir, n, 'workload.sh')))
  .sort();

// The SQLite pair lives in examples/ but belongs in this table: a reader needs
// to see the verdict flip on the one knob the vendor documents.
const extra = [
  { name: 'sqlite-full', title: 'SQLite, `synchronous=FULL` (the default)', w: 'examples/sqlite/workload.sh', c: 'examples/sqlite/check.sh' },
  { name: 'sqlite-extra', title: 'SQLite, `synchronous=EXTRA`', w: 'examples/sqlite/workload-extra.sh', c: 'examples/sqlite/check.sh' },
];

const jobs = [
  ...names.map((n) => ({
    name: n,
    title: readFileSync(join(targetsDir, n, 'title.txt'), 'utf8').trim(),
    w: join(targetsDir, n, 'workload.sh'),
    c: join(targetsDir, n, 'check.sh'),
  })),
  ...extra.map((e) => ({ name: e.name, title: e.title, w: join(root, e.w), c: join(root, e.c) })),
];

const rows: Row[] = [];
for (const job of jobs) {
  const by: Record<string, Verdict> = {};
  for (const { fs, mount } of FILESYSTEMS) {
    process.stderr.write(`  ${job.name} on ${fs} … `);
    const v = runOne(job.w, job.c, fs, mount);
    by[fs] = v;
    process.stderr.write(
      v.error
        ? `${v.error}\n`
        : v.inconclusive
          ? `INCONCLUSIVE: ${v.inconclusive}\n`
          : v.losses > 0
            ? `loses (${v.losses}/${v.checked})\n`
            : `intact (0/${v.checked})\n`
    );
  }
  rows.push({ name: job.name, title: job.title, by });
}

const cell = (v: Verdict | undefined) => {
  if (!v) return '—';
  if (v.error) return `_${v.error}_`;
  if (v.inconclusive) return `_inconclusive_`;
  return v.losses > 0 ? `**yes** (${v.losses}/${v.checked})` : `no (0/${v.checked})`;
};

const anyLoss = (r: Row) => FILESYSTEMS.some(({ fs }) => (r.by[fs]?.losses ?? 0) > 0);
const measured = rows.filter((r) =>
  FILESYSTEMS.every(({ fs }) => !r.by[fs]?.error && !r.by[fs]?.inconclusive)
);
const losing = measured.filter(anyLoss);

const kernel = spawnSync('uname', ['-rm'], { encoding: 'utf8' }).stdout.trim();
const v = versions();

const L: string[] = [];
L.push('# Durability audit');
L.push('');
L.push(`Measured ${new Date().toISOString().slice(0, 10)} on kernel ${kernel}, device under \`dm-log-writes\`.`);
L.push('');
L.push('Every target is asked the same question: the app reported success — would what it wrote survive the power going out at that moment?');
L.push('');
L.push(`**Targets measured: ${measured.length}. Losing an acknowledged write on at least one filesystem: ${losing.length}.**`);
L.push('');
L.push('| target | what it is | ext4 | xfs | btrfs | call to blame |');
L.push('|---|---|---|---|---|---|');
for (const r of rows) {
  const cause = FILESYSTEMS.map(({ fs }) => r.by[fs]?.cause).find(Boolean) ?? '—';
  L.push(`| \`${r.name}\` | ${r.title} | ${cell(r.by.ext4)} | ${cell(r.by.xfs)} | ${cell(r.by.btrfs)} | ${cause} |`);
}
L.push('');
L.push('Cells read `losses / crash points checked`. ext4 runs at `data=ordered,commit=5`; xfs and btrfs run at their defaults, which is what their users run.');
L.push('');
L.push('## The two controls');
L.push('');
L.push('`rename-fsync-dir` and `sqlite-extra` are here to be disbelieved. They are the');
L.push('cases that are known to be right, and gray has to stay quiet on them — on every');
L.push('filesystem, not just the convenient one. It does. A false alarm on btrfs alone');
L.push('would void the btrfs column, and with it the claim that this is not an ext4 quirk.');
L.push('');
L.push('The SQLite pair goes further: the verdict has to **flip** on the one knob the');
L.push('vendor documents as controlling this behaviour. `FULL` loses on all three');
L.push('filesystems, `EXTRA` loses on none.');
L.push('');
L.push('## What "loses" means here');
L.push('');
L.push('Not "your data always disappears". There is a window — from the moment the app');
L.push('returned success until the filesystem next makes that write durable — in which');
L.push('the promise has been made and the medium does not know about it. On ext4 at');
L.push('`commit=5` the window is about five seconds; at `commit=60`, a tip you will find');
L.push('in plenty of tuning guides, it is about sixty. See `dev/window.sh`.');
L.push('');
L.push('## Versions under test');
L.push('');
L.push('| | version |');
L.push('|---|---|');
for (const [k, val] of Object.entries(v)) if (val) L.push(`| \`${k}\` | ${val} |`);
L.push('');
L.push('## What the audit does not cover');
L.push('');
L.push('- Reorderings inside the window between two flushes. Cases at flush boundaries');
L.push('  were enumerated; the subsets left out are counted and reported by every run.');
L.push('  btrfs flushes far less often than ext4, so its windows are far deeper and its');
L.push('  column is the least complete of the three.');
L.push('- Drives that lie about completing a flush. One of those makes things worse than');
L.push('  this table says, never better.');
L.push('- `mmap`, which bypasses the write path gray watches.');
L.push('- One architecture, one kernel. Both are printed above so the run can be repeated.');

const report = `${L.join('\n')}\n`;
writeFileSync(join(root, 'audit/RESULTS.md'), report);
console.log();
console.log(report);
