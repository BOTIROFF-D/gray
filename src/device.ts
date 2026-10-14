import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

/**
 * The loop-device and device-mapper scaffolding.
 *
 * The rig:
 *
 *   data.img  ──loop──┐
 *                     ├── dm-log-writes ── mkfs ── mount  ← the workload runs here
 *   log.img   ──loop──┘        │
 *                              └── every write, in order, with its barriers
 *
 *   replay.img ──loop── a blank device where a post-crash state is assembled
 *        │
 *        └── dm-snapshot ── mounted, which runs the filesystem's recovery
 *                 ▲
 *            cow.img ──loop── where recovery's own writes land and die
 *
 * The snapshot is a necessity, not a convenience. Mounting does not only read:
 * journal recovery rewrites blocks and updates the superblock. Without the
 * snapshot every check would corrupt the device the next state is built on,
 * and the enumeration would be walking post-crash states layered on top of
 * somebody else's recovery.
 *
 * Why three images and not two: by the end of the run the device under the
 * workload already holds everything, and it cannot be rewound. A post-crash
 * state is assembled separately, from nothing.
 */

export type Fs = 'ext4' | 'xfs' | 'btrfs';

export type Bed = {
  work: string;
  dmName: string;
  dataLoop: string;
  logLoop: string;
  replayLoop: string;
  cowLoop: string;
  snapName: string;
  logImage: string;
  mnt: string;
  replayMnt: string;
};

const sh = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const quiet = (cmd: string, args: string[]): void => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {
    /* teardown is allowed to fail: we remove things that may already be gone */
  }
};

export function requireRoot(): void {
  if (process.getuid?.() !== 0) {
    throw new Error(
      'root is required: device-mapper and loop devices are not reachable otherwise.\n' +
        'run this under sudo'
    );
  }
}

export function checkKernelSupport(): void {
  let targets = '';
  try {
    targets = sh('dmsetup', ['targets']);
  } catch {
    throw new Error('dmsetup is not available — install the dmsetup package');
  }
  if (!/\blog-writes\b/.test(targets)) {
    throw new Error(
      'this kernel has no dm-log-writes target.\n' +
        'on Ubuntu: sudo apt install linux-modules-extra-$(uname -r) && sudo modprobe dm-log-writes'
    );
  }
}

export function setupBed(work: string, sizeMiB: number, dmName = 'graylog'): Bed {
  teardownBed({ work, dmName } as Bed);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const bed: Bed = {
    work,
    dmName,
    dataLoop: '',
    logLoop: '',
    replayLoop: '',
    cowLoop: '',
    snapName: `${dmName}-snap`,
    logImage: `${work}/log.img`,
    mnt: `${work}/mnt`,
    replayMnt: `${work}/replay-mnt`,
  };
  mkdirSync(bed.mnt, { recursive: true });
  mkdirSync(bed.replayMnt, { recursive: true });

  for (const name of ['data', 'log', 'replay']) {
    sh('truncate', ['-s', `${sizeMiB}M`, `${work}/${name}.img`]);
  }
  // Enough room for whatever journal recovery decides to rewrite.
  sh('truncate', ['-s', `${Math.max(64, Math.ceil(sizeMiB / 4))}M`, `${work}/cow.img`]);

  bed.dataLoop = sh('losetup', ['--show', '-f', `${work}/data.img`]);
  bed.logLoop = sh('losetup', ['--show', '-f', `${work}/log.img`]);
  bed.replayLoop = sh('losetup', ['--show', '-f', `${work}/replay.img`]);
  bed.cowLoop = sh('losetup', ['--show', '-f', `${work}/cow.img`]);

  const sectors = sh('blockdev', ['--getsz', bed.dataLoop]);
  sh('dmsetup', ['create', dmName, '--table', `0 ${sectors} log-writes ${bed.dataLoop} ${bed.logLoop}`]);

  return bed;
}

export function makeFs(bed: Bed, fs: Fs): void {
  const dev = `/dev/mapper/${bed.dmName}`;
  if (fs === 'ext4') sh('mkfs.ext4', ['-q', '-F', dev]);
  else if (fs === 'xfs') sh('mkfs.xfs', ['-q', '-f', dev]);
  else sh('mkfs.btrfs', ['-q', '-f', dev]);
}

export function mount(dev: string, at: string, options?: string): void {
  const args = options ? ['-o', options, dev, at] : [dev, at];
  sh('mount', args);
}

export function umount(at: string): void {
  quiet('umount', [at]);
}

/** A mark in the journal: a named point to rewind to later. */
export function mark(bed: Bed, name: string): void {
  sh('dmsetup', ['message', bed.dmName, '0', 'mark', name]);
}

export function removeDm(bed: Bed): void {
  quiet('dmsetup', ['remove', bed.dmName]);
}

/**
 * Brings up a throwaway snapshot over the assembled state and returns a
 * device that is safe to mount.
 *
 * The snapshot is transient (`N`): its copy-on-write store starts clean on
 * every create, so nothing has to be zeroed by hand between checks.
 */
export function openSnapshot(bed: Bed): string {
  closeSnapshot(bed);
  const sectors = sh('blockdev', ['--getsz', bed.replayLoop]);
  sh('dmsetup', [
    'create',
    bed.snapName,
    '--table',
    `0 ${sectors} snapshot ${bed.replayLoop} ${bed.cowLoop} N 8`,
  ]);
  return `/dev/mapper/${bed.snapName}`;
}

export function closeSnapshot(bed: Bed): void {
  quiet('dmsetup', ['remove', bed.snapName]);
}

/** Blanks the target device: the paranoid path starts from zero every time. */
export function blankReplay(bed: Bed, sizeMiB: number): void {
  sh('dd', [
    'if=/dev/zero',
    `of=${bed.replayLoop}`,
    'bs=1M',
    `count=${sizeMiB}`,
    'conv=fsync',
    'status=none',
  ]);
}

/**
 * A separate filesystem of the same type, for the diagnostic run under
 * strace. No `dm-log-writes` here: the question is not what the disk did but
 * what the application asked for, and this run must not be mixed into the
 * journal the verdict came from.
 */
export function setupPlain(work: string, sizeMiB: number, fs: Fs, options?: string): string {
  const img = `${work}/plain.img`;
  const mnt = `${work}/plain-mnt`;
  teardownPlain(work);
  mkdirSync(mnt, { recursive: true });
  sh('truncate', ['-s', `${sizeMiB}M`, img]);
  const loop = sh('losetup', ['--show', '-f', img]);
  if (fs === 'ext4') sh('mkfs.ext4', ['-q', '-F', loop]);
  else if (fs === 'xfs') sh('mkfs.xfs', ['-q', '-f', loop]);
  else sh('mkfs.btrfs', ['-q', '-f', loop]);
  mount(loop, mnt, options);
  return mnt;
}

export function teardownPlain(work: string): void {
  quiet('umount', [`${work}/plain-mnt`]);
  const img = `${work}/plain.img`;
  if (!existsSync(img)) return;
  try {
    for (const line of sh('losetup', ['-j', img]).split('\n').filter(Boolean)) {
      const dev = line.split(':')[0];
      if (dev) quiet('losetup', ['-d', dev]);
    }
  } catch {
    /* nothing to detach */
  }
}

export function teardownBed(bed: Pick<Bed, 'work' | 'dmName'>): void {
  for (const at of [`${bed.work}/mnt`, `${bed.work}/replay-mnt`]) {
    if (existsSync(at)) quiet('umount', [at]);
  }
  quiet('dmsetup', ['remove', `${bed.dmName}-snap`]);
  quiet('dmsetup', ['remove', bed.dmName]);
  for (const name of ['data', 'log', 'replay', 'cow']) {
    const img = `${bed.work}/${name}.img`;
    if (!existsSync(img)) continue;
    let used = '';
    try {
      used = sh('losetup', ['-j', img]);
    } catch {
      continue;
    }
    for (const line of used.split('\n').filter(Boolean)) {
      const dev = line.split(':')[0];
      if (dev) quiet('losetup', ['-d', dev]);
    }
  }
}
