import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Finding the syscall to blame.
 *
 * The enumeration answers "is data lost", and answers it reliably, because it
 * watches the block layer. But "lost at crash points #101–#111" cannot be
 * fixed: a person needs a line of code, not a journal entry number.
 *
 * So after a finding the workload runs a second time, under strace, on a
 * separate filesystem of the same type. No block journal is needed here: the
 * question is what the application asked for, not what the disk did. A second
 * run rather than one shared run, for a blunt reason — strace slows things
 * down by an order of magnitude, and in that time the journal commit timer
 * fires. The loss would vanish and the tool would report that all is well.
 * That is precisely the way of lying gray exists to argue against.
 *
 * The rules are deliberately boring and checkable:
 *
 *   1. An operation on a directory (rename, unlink, link, file creation) with
 *      no fsync of that directory afterwards. A directory entry is durable
 *      only once the directory itself is synced.
 *   2. A write to a file with no fsync or fdatasync of that file afterwards.
 *
 * Each rule is printed together with the call and the path, so the output can
 * be checked rather than believed.
 */

export type Syscall = {
  /** Position in the trace; causes are ordered by it. */
  index: number;
  time: number;
  name: string;
  /** Paths the call touches. A rename has two. */
  paths: string[];
  result: string;
};

export type Cause = {
  rule: 'directory' | 'file';
  call: Syscall;
  /** The path that was left unsynced. */
  path: string;
  explanation: string;
};

export function straceAvailable(): boolean {
  return spawnSync('sh', ['-c', 'command -v strace'], { stdio: 'ignore' }).status === 0;
}

/** Calls that change a directory's contents: each needs a directory fsync after it. */
const DIRECTORY_OPS = new Set([
  'rename',
  'renameat',
  'renameat2',
  'unlink',
  'unlinkat',
  'link',
  'linkat',
  'symlink',
  'symlinkat',
  'mkdir',
  'mkdirat',
  'rmdir',
  'creat',
]);

const WRITE_OPS = new Set(['write', 'pwrite64', 'writev', 'pwritev']);
const FILE_SYNC_OPS = new Set(['fsync', 'fdatasync']);
const GLOBAL_SYNC_OPS = new Set(['sync', 'syncfs']);

const TRACED = [
  ...DIRECTORY_OPS,
  ...WRITE_OPS,
  ...FILE_SYNC_OPS,
  ...GLOBAL_SYNC_OPS,
  'openat',
  'open',
].join(',');

/**
 * Parsing one strace line.
 *
 * Under `-f -y -ttt` the shape is:
 *   PID  TIME  call(args) = result
 * `-y` annotates descriptors with their path: `4</tmp/x/config.json>`.
 */
function parseLine(line: string): Syscall | null {
  const m = line.match(/^\s*(?:\d+\s+)?(\d+\.\d+)\s+([a-z_0-9]+)\((.*)\)\s+=\s+(-?\w+)/);
  if (!m) return null;
  const [, time, name, args, result] = m;
  // An empty argument list is legal: `sync()`, `fork()`. It must not be
  // tested for truthiness — an empty string is falsy, and such calls would
  // drop out of the parse in silence. That is exactly how the diagnosis once
  // missed a `sync` and blamed a write that was already covered.
  if (!time || !name || args === undefined || result === undefined) return null;

  const paths: string[] = [];
  // Quoted paths: rename("a", "b"), openat(AT_FDCWD, "a", ...)
  for (const q of args.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    if (q[1]) paths.push(q[1]);
  }
  // Paths that -y attaches to a descriptor: 4</tmp/x>
  for (const f of args.matchAll(/\d+<([^>]+)>/g)) {
    if (f[1]) paths.push(f[1]);
  }

  return { index: 0, time: Number(time), name, paths, result };
}

export function collectSyscalls(
  workload: string,
  mnt: string,
  logPath: string,
  env: NodeJS.ProcessEnv = {}
): Syscall[] {
  spawnSync('rm', ['-f', logPath]);
  const r = spawnSync(
    'strace',
    ['-f', '-y', '-ttt', '-s', '0', '-e', `trace=${TRACED}`, '-o', logPath, 'sh', '-c', workload],
    { encoding: 'utf8', env: { ...process.env, GRAY_MNT: mnt, GRAY_DM: '', PATH: process.env.PATH ?? '', ...env } }
  );
  if (r.status !== 0 && !existsSync(logPath)) return [];

  const calls: Syscall[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    // Unfinished and resumed calls are skipped: their arguments are split
    // across two lines, and stitching them back together is not worth the
    // risk of misparsing for the sake of a diagnosis.
    if (line.includes('<unfinished') || line.includes('resumed>')) continue;
    const call = parseLine(line);
    if (call) {
      call.index = calls.length;
      calls.push(call);
    }
  }
  return calls;
}

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

/**
 * Applies the rules to a sequence of calls and returns causes, most likely
 * first.
 *
 * Only what happens inside the directory under test counts: a workload also
 * reads shared libraries and writes to system temporaries, and complaining
 * about those would be noise.
 */
/**
 * The paths the check actually reads.
 *
 * Used to filter. A workload breaks the rule in many places at once — `git
 * commit` does it in twelve — and most of those have nothing to do with the
 * loss: a lock file being removed also "changed a directory without syncing
 * it", but the check never opens it. The cause that matters is the one
 * touching what the check looks at.
 */
export function readPaths(calls: Syscall[], mnt: string): Set<string> {
  const paths = new Set<string>();
  for (const c of calls) {
    if (c.result.startsWith('-')) continue;
    for (const p of c.paths) if (p.startsWith(mnt)) paths.add(p);
  }
  return paths;
}

export function diagnose(calls: Syscall[], mnt: string, observed: Set<string> = new Set()): Cause[] {
  const inside = (p: string) => p.startsWith(mnt);
  const causes: Cause[] = [];

  // A global sync covers everything that came before it.
  const lastGlobalSync = calls.reduce(
    (acc, c, i) => (GLOBAL_SYNC_OPS.has(c.name) && c.result === '0' ? i : acc),
    -1
  );

  const syncedDirsAfter = (index: number): Set<string> => {
    const dirs = new Set<string>();
    for (let i = index + 1; i < calls.length; i++) {
      const c = calls[i]!;
      if (GLOBAL_SYNC_OPS.has(c.name)) {
        dirs.add('*');
        continue;
      }
      if (FILE_SYNC_OPS.has(c.name)) for (const p of c.paths) dirs.add(p);
    }
    return dirs;
  };

  for (const [i, call] of calls.entries()) {
    if (i < lastGlobalSync) continue;
    if (call.result.startsWith('-')) continue;

    const touched = call.paths.filter(inside);
    if (touched.length === 0) continue;

    if (DIRECTORY_OPS.has(call.name)) {
      // A rename changes two directories; usually they are the same one.
      const dirs = [...new Set(touched.map(dirname))];
      const synced = syncedDirsAfter(i);
      for (const dir of dirs) {
        if (synced.has('*') || synced.has(dir)) continue;
        causes.push({
          rule: 'directory',
          call,
          path: dir,
          explanation:
            `${call.name}(${touched.map((p) => `"${p}"`).join(' → ')}) changes the contents of ` +
            `directory "${dir}", and that directory is never fsynced afterwards. ` +
            `A directory entry survives power loss only once the directory itself is ` +
            `fsynced — fsyncing the file does not cover it.`,
        });
      }
      continue;
    }

    if (WRITE_OPS.has(call.name)) {
      const file = touched[0];
      if (!file) continue;
      const synced = syncedDirsAfter(i);
      if (synced.has('*') || synced.has(file)) continue;
      causes.push({
        rule: 'file',
        call,
        path: file,
        explanation:
          `the write to "${file}" is not followed by fsync or fdatasync on that file. ` +
          `Until it is synced the data lives only in a page of memory.`,
      });
    }
  }

  // The same directory is usually at fault many times over: report it once.
  const seen = new Set<string>();
  const distinct = causes.filter((c) => {
    const key = `${c.rule}:${c.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  /*
   * Relevance: does the cause touch what the check reads?
   *
   * For the directory rule — did the check read a file sitting DIRECTLY in
   * that directory. One level deeper does not count: `git log` opens
   * `.git/objects/xx/yyyy`, and if nesting counted, the whole of
   * `.git/objects` would come out relevant along with every lock file ever
   * removed there.
   */
  const relevant = (c: Cause): boolean => {
    if (observed.size === 0) return true;
    if (c.rule === 'file') return observed.has(c.path);
    for (const p of observed) {
      const i = p.lastIndexOf('/');
      if (i > 0 && p.slice(0, i) === c.path) return true;
    }
    return false;
  };

  /*
   * Order: relevant ones first, and within those, latest first.
   *
   * The durability promise is made at the end of the workload, so what is
   * answerable for it is usually the last operation that moves the state
   * forward: a ref being renamed, a journal being removed, a file being
   * swapped in. On a tie the directory rule wins: people find a missing file
   * fsync on their own, a missing directory fsync almost never.
   */
  return distinct.sort((a, b) => {
    const ra = relevant(a) ? 1 : 0;
    const rb = relevant(b) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    if (b.call.index !== a.call.index) return b.call.index - a.call.index;
    return a.rule === 'directory' ? -1 : 1;
  });
}
