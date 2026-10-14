/**
 * Cross-checking our replay against the reference from xfstests.
 *
 * For a set of crash points we assemble the image both ways and compare
 * hashes. The same move as running an exhaustive search alongside a reduced
 * one: two independent ways to reach one answer, and the verdicts have to
 * match. Ours is faster and installs with one command; theirs has been
 * reading these journals for years. A disagreement means ours is wrong.
 *
 * Mind the offset: the reference's `--limit N` replays entries 0..N-1, while
 * our `replayTo(N)` covers 0..N inclusive. Compare N against N-1.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { crashPoints, readLog } from '../src/log.ts';
import { replayTo } from '../src/replay.ts';

const journal = process.argv[2] ?? '/var/tmp/gray-log/journal.bin';
const reference = process.argv[3] ?? `${process.env.HOME}/ref/replay-log`;
const work = '/var/tmp/gray-crosscheck';

execFileSync('mkdir', ['-p', work]);
const mineImg = `${work}/mine.img`;
const theirsImg = `${work}/theirs.img`;

const log = readLog(journal);
const SIZE = 256 * 1024 * 1024;

const blank = (path: string) => {
  execFileSync('truncate', ['-s', '0', path]);
  execFileSync('truncate', ['-s', String(SIZE), path]);
};

const sha = (path: string) => {
  const fd = openSync(path, 'r');
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  let pos = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    h.update(buf.subarray(0, n));
    pos += n;
  }
  closeSync(fd);
  return h.digest('hex').slice(0, 16);
};

// Barriers plus a few arbitrary points: they have to agree everywhere, not
// only where it is convenient.
const points = [...new Set([...crashPoints(log, 'barriers'), 1, 7, 42, log.entries.length - 1])]
  .filter((p) => p >= 0 && p < log.entries.length)
  .sort((a, b) => a - b);

console.log(`journal ${journal} · ${log.entries.length} entries · comparing ${points.length} points`);
console.log();

let failures = 0;
for (const p of points) {
  blank(mineImg);
  replayTo(journal, log, mineImg, p);
  const mine = sha(mineImg);

  blank(theirsImg);
  execFileSync(reference, ['--log', journal, '--replay', theirsImg, '--limit', String(p + 1)], {
    stdio: 'pipe',
  });
  const theirs = sha(theirsImg);

  const ok = mine === theirs;
  if (!ok) failures++;
  if (!ok || p === points[0] || p === points.at(-1)) {
    console.log(`  ${ok ? 'ok' : 'XX'} point #${String(p).padStart(4)}  ours ${mine}  reference ${theirs}`);
  }
}

console.log();
console.log(
  failures === 0
    ? `CROSS-CHECK PASSED: ${points.length} points, images byte-identical`
    : `CROSS-CHECK FAILED: ${failures} disagreements of ${points.length}`
);
process.exit(failures === 0 ? 0 : 1);
