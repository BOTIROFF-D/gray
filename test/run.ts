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
  const fsFlag = extra.includes('--fs');
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cli, 'run', '--workload', workload, '--check', check,
     ...(fsFlag ? [] : ['--mount-options', 'data=ordered,commit=5']), ...extra],
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

// Kept for the inconclusive section below: it must still read as a plain pass.
const correctFinal = gray(ex('atomic-write/workload-correct.sh'), ex('atomic-write/check.sh'));

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
console.log('-- the verdict must not wander --');
/*
 * A tool whose answer changes between runs is the thing it was written to
 * catch. gray's verdict is taken from one execution of the workload, so the
 * states it can reach are the ones that execution produced; if its own answer
 * wandered, every number in the audit would be a coin toss.
 */
const repeated = gray(ex('atomic-write/workload.sh'), ex('atomic-write/check.sh'), ['--repeat', '3']);
expect('the same verdict across three runs', /the same verdict every time/.test(repeated.out));

const quietRepeated = gray(ex('atomic-write/workload-correct.sh'), ex('atomic-write/check.sh'), ['--repeat', '3']);
expect(
  'the control stays quiet across three runs',
  quietRepeated.losses === 0 && /the same verdict every time/.test(quietRepeated.out),
  `${quietRepeated.losses} losses`
);

console.log();
console.log('-- barriers and all modes must agree on the verdict --');
// `--mode all` checks every write rather than every barrier, so it reports more
// failing points. What it must not do is disagree about whether anything is
// lost at all: the two modes differ in resolution, not in what is true.
const allMode = gray(ex('atomic-write/workload.sh'), ex('atomic-write/check.sh'), ['--mode', 'all']);
expect(
  'both modes find the loss',
  allMode.losses > 0 && fast.losses > 0,
  `barriers ${fast.losses}, all ${allMode.losses}`
);
expect('the all mode checks strictly more points', allMode.checked > fast.checked, `${fast.checked} -> ${allMode.checked}`);

console.log();
console.log('-- the finding must not be an ext4 quirk --');
// If the loss only showed up on one filesystem it would be a property of that
// filesystem, not of the code under test. Both other filesystems run at their
// defaults, which is what their users run.
for (const fs of ['xfs', 'btrfs']) {
  const loses = gray(ex('atomic-write/workload.sh'), ex('atomic-write/check.sh'), ['--fs', fs, '--size', '512']);
  const quiet = gray(ex('atomic-write/workload-correct.sh'), ex('atomic-write/check.sh'), ['--fs', fs, '--size', '512']);
  expect(`${fs}: the missing directory fsync still loses`, loses.losses > 0, `${loses.losses} of ${loses.checked}`);
  expect(`${fs}: the control still stays quiet`, quiet.losses === 0, `${quiet.losses} of ${quiet.checked}`);
}

console.log();
console.log('-- the window must close, and --settle must find it --');
/*
 * The loss is not forever. The filesystem commits its journal on a timer, and
 * once it has, the promise is real. `--settle n` asks whether a machine that
 * stayed up n seconds is safe yet, so it has to find the far side of that
 * window — otherwise the tool would be telling people their data is gone when
 * it is merely late.
 */
const settled = gray(ex('atomic-write/workload.sh'), ex('atomic-write/check.sh'), ['--settle', '10']);
expect('ten seconds of uptime is enough at commit=5', settled.losses === 0, `${settled.losses} losses`);
expect('and it is a plain pass, not an inconclusive one', /^PASS/m.test(settled.out));
expect('the report says the crashes were filtered', /Only crashes at least 10s/.test(settled.out));
expect('no settle still loses', fast.losses > 0, `${fast.losses} losses`);

console.log();
console.log('-- a run that proves nothing must not look like a pass --');
/*
 * The two ways gray could have quietly lied.
 *
 * A workload that never promises anything leaves $GRAY_ACKED empty, every
 * check exits zero, and a naive tool prints PASS. A check that returns zero
 * unconditionally does the same. Both are green runs that could not have been
 * anything else — the exact failure this tool was written to argue against,
 * and there is no excuse for it appearing in the tool itself.
 */
const fx = (p: string) => join(root, 'test/fixtures', p);

const noPromise = gray(fx('no-ack.sh'), fx('always-passes.sh'));
expect('a workload with no ack is called inconclusive', /INCONCLUSIVE.*never called/s.test(noPromise.out));
expect('and does not exit zero', noPromise.code === 2, `exit ${noPromise.code}`);

const blindCheck = gray(fx('with-ack.sh'), fx('always-passes.sh'));
expect('a check that cannot fail is called inconclusive', /INCONCLUSIVE.*cannot fail/s.test(blindCheck.out));
expect('and does not exit zero', blindCheck.code === 2, `exit ${blindCheck.code}`);

expect(
  'a real control is still a plain pass, not inconclusive',
  /^PASS/m.test(correctFinal.out) && !/INCONCLUSIVE/.test(correctFinal.out),
  correctFinal.out.split('\n').find((l) => /^(PASS|FAIL|INCONCLUSIVE)/.test(l)) ?? ''
);

console.log();
console.log('-- the report must state the limits of the search --');
expect('what the search did not cover is printed', /What the search did not cover/.test(fast.out));
expect('the depth of the unexplored window is given', /Deepest window: \d+ writes in flight/.test(fast.out));
expect('the unenumerated subsets are counted', /Subsets of them left unenumerated/.test(fast.out));

console.log();
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
