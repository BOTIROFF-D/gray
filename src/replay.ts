import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { LOG_FLAG, type ParsedLog, hasFlag } from './log.ts';

/**
 * Replaying the journal onto a device: assembling the state the disk would
 * have been left in had the power failed at a given point.
 *
 * This is our own replay rather than a call out to xfstests' `replay-log`,
 * and not out of pride: a tool people install with one command cannot demand
 * a clone of the kernel test suite and a C compiler. But since it is ours, it
 * is obliged to agree with theirs — which is what `test/replay-crosscheck.ts`
 * checks: both replays of the same journal must produce byte-identical images.
 *
 * The conversion rule comes from `log-writes.c`: the offset on the target is
 * `sector × sectorSize`, the length is `nrSectors × sectorSize`. `dataLen`
 * plays no part here; it describes the header's inline data.
 */

export type ReplayOptions = {
  /** Handle DISCARD by zeroing the range. */
  discard?: boolean;
};

/** How much is zeroed at a time, so a whole range never sits in memory. */
const ZERO_CHUNK = 4 * 1024 * 1024;
const ZEROS = Buffer.alloc(ZERO_CHUNK);

/**
 * Applies journal entries `from` through `to`, inclusive.
 *
 * Used two ways. Fast: crash points run in increasing order, so each one only
 * ships the new entries on top of the previous state. That yields exactly the
 * image a replay from zero would — same writes, same order, the early ones
 * simply not repeated. Paranoid: from zero, every time.
 */
export function replayRange(
  logPath: string,
  log: ParsedLog,
  targetPath: string,
  from: number,
  to: number,
  options: ReplayOptions = {}
): { written: number; discarded: number } {
  const discard = options.discard ?? true;
  const logFd = openSync(logPath, 'r');
  const targetFd = openSync(targetPath, 'r+');
  let written = 0;
  let discarded = 0;

  try {
    for (let i = from; i <= to; i++) {
      const entry = log.entries[i];
      if (!entry) break;

      const offset = Number(entry.sector) * log.sectorSize;
      const size = Number(entry.nrSectors) * log.sectorSize;
      if (size === 0) continue; // marks and bare flushes carry nothing

      if (hasFlag(entry, LOG_FLAG.DISCARD)) {
        if (!discard) continue;
        for (let done = 0; done < size; done += ZERO_CHUNK) {
          const chunk = Math.min(ZERO_CHUNK, size - done);
          writeSync(targetFd, ZEROS, 0, chunk, offset + done);
        }
        discarded++;
        continue;
      }

      // The payload sits in the journal immediately after the header sector.
      const payload = Buffer.allocUnsafe(size);
      const got = readSync(logFd, payload, 0, size, entry.offset + log.sectorSize);
      if (got < size) {
        throw new Error(`journal truncated at entry #${i}: expected ${size} bytes, read ${got}`);
      }
      writeSync(targetFd, payload, 0, size, offset);
      written++;
    }
  } finally {
    closeSync(logFd);
    closeSync(targetFd);
  }

  return { written, discarded };
}

/**
 * Replays the journal from the beginning through point `to`, inclusive.
 *
 * The reference tool's `--no-discard` exists for a reason: the first thing
 * mkfs does is discard the entire device, and zeroing a quarter of a gigabyte
 * at every crash point costs more than the check itself. When the target is
 * known to be blank, skipping the zeroing changes nothing.
 */
export function replayTo(
  logPath: string,
  log: ParsedLog,
  targetPath: string,
  to: number,
  options: ReplayOptions = {}
): { written: number; discarded: number } {
  return replayRange(logPath, log, targetPath, 0, to, options);
}
