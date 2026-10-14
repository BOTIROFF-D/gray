/**
 * gray's own tests.
 *
 * A tool that claims "your data is being lost" owes you proof that it stays
 * quiet where everything is right. Crying wolf on correct code is worse than
 * having no tool at all: it loses its credibility at the exact moment it
 * finds a real loss. So the controls come first and the finding comes last.
 *
 * Usage (needs root and a kernel with dm-log-writes):
 *   sudo node --experimental-strip-types test/run.ts
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src/cli.ts');

type Verdict = { losses: number; checked: number; code: number; out: string };

function gray(workload: string, check: string, extra: string[] = []): Verdict {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cli, 'run', '--workload', workload, '--check', check,
     '--mount-options', 'data=ordered,commit=5', ...extra],
    { encoding: 'utf8', cwd: root }
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const loss = out.match(/lost in (\d+) of (\d+)/);
  return {
    losses: loss ? Number(loss[1]) : 0,
    checked: loss ? Number(loss[2]) : Number(out.match(/Crash points checked: (\d+)/)?.[1] ?? 0),
    code: r.status ?? -1,
    out,
  };
}

let failed = 0;
function expect(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

const ex = (p: string) => join(root, 'examples', p);

console.log('-- controls: gray must stay quiet --');

for (const mode of [[], ['--paranoid']]) {
  const label = mode.length ? 'paranoid' : 'fast';

  const correct = gray(ex('atomic-write/workload-correct.sh'), ex('atomic-write/check.sh'), mode);
  expect(
    `rename + directory fsync, ${label} path`,
    correct.losses === 0 && correct.checked > 0,
    `${correct.losses} losses of ${correct.checked}`
  );

  const sqliteExtra = gray(ex('sqlite/workload-extra.sh'), ex('sqlite/check.sh'), mode);
  expect(
    `SQLite synchronous=EXTRA, ${label} path`,
    sqliteExtra.losses === 0 && sqliteExtra.checked > 0,
    `${sqliteExtra.losses} losses of ${sqliteExtra.checked}`
  );
}

console.log();
console.log('-- differential control: the verdict must flip with the knob --');
// The strongest calibration available. SQLite documents that at
// synchronous=FULL, its default, a transaction committed right before a power
// loss may be rolled back on reboot, and that synchronous=EXTRA closes it by
// syncing the directory after the journal is unlinked. If gray shouts at FULL
// and stays quiet at EXTRA, it is sensitive to exactly the right thing rather
// than to anything at all.
const full = gray(ex('sqlite/workload.sh'), ex('sqlite/check.sh'));
const extra = gray(ex('sqlite/workload-extra.sh'), ex('sqlite/check.sh'));
expect('SQLite FULL — loss found', full.losses > 0, `${full.losses} losses of ${full.checked}`);
expect('SQLite EXTRA — silence', extra.losses === 0, `${extra.losses} losses of ${extra.checked}`);

console.log();
console.log('-- the finding: gray must catch it --');

const fast = gray(ex('atomic-write/workload.sh'), ex('atomic-write/check.sh'));
expect('write-file-atomic@8 loses an acknowledged write', fast.losses > 0, `${fast.losses} losses of ${fast.checked}`);
expect('the report names the promise that was broken', /gray:ack:v2/.test(fast.out));
expect('the report names what was promised and what was found', /acknowledged "v2".*"v1"/s.test(fast.out));
expect('non-zero exit status on a finding', fast.code === 1);

console.log();
console.log('-- the diagnosis must name the offending call --');
// "lost at crash points #101-#111" cannot be acted on: a person needs the
// syscall, not the journal entry number. Check that both the call and the
// unsynced directory are named.
expect('renameat is named', /renameat\(/.test(fast.out));
expect('the unsynced directory is named', /directory "[^"]+", and that directory is never fsynced/.test(fast.out));
// The cause that matters must come first, not be buried under noise: the
// ranking exists precisely so the top line is the one worth acting on.
const firstCause = fast.out.split('Likely cause\n')[1]?.split('\n')[0]?.trim() ?? '';
expect('the top cause is the offending rename', /^renameat\(/.test(firstCause), firstCause.slice(0, 60));
expect("SQLite's journal unlinkat is named", /unlinkat\(.*journal/.test(full.out));

console.log();
console.log('-- the fast and paranoid paths must agree --');
// A regression test for a bug we hit: mounting writes to the device, because
// journal recovery edits blocks and the superblock. While the check mounted
// the assembled state directly, every next crash point was built on top of
// those edits, and the fast path cried wolf on correct code. The cure is a
// throwaway dm-snapshot per check.
const slow = gray(ex('atomic-write/workload.sh'), ex('atomic-write/check.sh'), ['--paranoid']);
expect(
  'the same loss count on the same workload',
  fast.losses === slow.losses,
  `fast ${fast.losses}, paranoid ${slow.losses}`
);

console.log();
console.log('-- the report must state the limits of the search --');
expect('what the search did not cover is printed', /What the search did not cover/.test(fast.out));
expect('the number of unchecked states is given', /States left unchecked/.test(fast.out));

console.log();
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
