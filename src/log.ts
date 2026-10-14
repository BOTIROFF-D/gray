import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * Parser for the `dm-log-writes` journal.
 *
 * `dm-log-writes` is a device-mapper target that passes writes through to the
 * real device and keeps a copy of each one, in order, with the flush and FUA
 * barriers intact. This is not a model of what happens to your data and not a
 * guess: it is what the block layer actually sent down, in the order it sent it.
 *
 * The format lives in the kernel (`drivers/md/dm-log-writes.c`) and is mirrored
 * in `src/log-writes/log-writes.h` in xfstests. It was read from there rather
 * than reconstructed from observation: a guessed format is a tool that lies
 * quietly.
 *
 * Layout:
 *
 *   offset 0            superblock (28 bytes), padded out to one sector
 *   offset sectorSize   first entry
 *
 * Each entry:
 *
 *   header    exactly one sector: four 8-byte fields, then inline data
 *             (the mark text, when the entry is a mark)
 *   payload   nrSectors × sectorSize bytes, when nrSectors > 0 and the
 *             entry is not a DISCARD
 *
 * Note the payload length comes from `nrSectors`, NOT from `dataLen`.
 * `dataLen` describes the inline data in the header. Confusing the two means
 * losing sync with the journal at the first mark and reading garbage after it.
 */

/** Journal entry flags. Values come from the kernel and cannot be changed. */
export const LOG_FLAG = {
  FLUSH: 1 << 0,
  FUA: 1 << 1,
  DISCARD: 1 << 2,
  MARK: 1 << 3,
  METADATA: 1 << 4,
} as const;

const WRITE_LOG_MAGIC = 0x6a736677736872n;
const WRITE_LOG_VERSION = 1n;

/** Header size in bytes: sector, nr_sectors, flags, data_len. */
const ENTRY_HEADER_BYTES = 8 * 4;

export type LogEntry = {
  /** Position in the journal, from zero. Also the crash point "after this write". */
  index: number;
  /** Device sector the write was headed for. */
  sector: bigint;
  /** Length of the write in sectors. Zero for marks and bare flushes. */
  nrSectors: bigint;
  flags: number;
  /** The mark text, when this entry is a mark. */
  mark?: string;
  /** Byte offset of this header in the journal. For diagnostics, not for logic. */
  offset: number;
};

export type ParsedLog = {
  sectorSize: number;
  /** How many entries the superblock promises. */
  declaredEntries: number;
  /** How many were actually read. A mismatch means the journal was cut short. */
  entries: LogEntry[];
  truncated: boolean;
};

export function hasFlag(entry: LogEntry, flag: number): boolean {
  return (entry.flags & flag) !== 0;
}

/** Human-readable flags, for reports — never for logic. */
export function flagsToString(flags: number): string {
  const names: string[] = [];
  if (flags & LOG_FLAG.FLUSH) names.push('FLUSH');
  if (flags & LOG_FLAG.FUA) names.push('FUA');
  if (flags & LOG_FLAG.DISCARD) names.push('DISCARD');
  if (flags & LOG_FLAG.MARK) names.push('MARK');
  if (flags & LOG_FLAG.METADATA) names.push('METADATA');
  return names.length ? names.join('|') : '—';
}

export function readLog(path: string): ParsedLog {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.allocUnsafe(ENTRY_HEADER_BYTES);
    if (readSync(fd, head, 0, 28, 0) < 28) {
      throw new Error(`journal ${path} is shorter than its superblock`);
    }

    const magic = head.readBigUInt64LE(0);
    if (magic !== WRITE_LOG_MAGIC) {
      throw new Error(
        `not a dm-log-writes journal: magic ${magic.toString(16)}, expected ${WRITE_LOG_MAGIC.toString(16)}`
      );
    }
    const version = head.readBigUInt64LE(8);
    if (version !== WRITE_LOG_VERSION) {
      throw new Error(`journal version ${version}, only ${WRITE_LOG_VERSION} is supported`);
    }

    const declaredEntries = Number(head.readBigUInt64LE(16));
    const sectorSize = head.readUInt32LE(24);
    if (sectorSize < ENTRY_HEADER_BYTES || sectorSize % 512 !== 0) {
      throw new Error(`implausible sector size: ${sectorSize}`);
    }

    const size = statSync(path).size;
    const sector = Buffer.allocUnsafe(sectorSize);
    const entries: LogEntry[] = [];
    let pos = sectorSize;
    let truncated = false;

    for (let index = 0; index < declaredEntries; index++) {
      if (pos + sectorSize > size) {
        truncated = true;
        break;
      }
      if (readSync(fd, sector, 0, sectorSize, pos) < sectorSize) {
        truncated = true;
        break;
      }

      const flags = Number(sector.readBigUInt64LE(16));
      const nrSectors = sector.readBigUInt64LE(8);
      const dataLen = Number(sector.readBigUInt64LE(24));

      const entry: LogEntry = {
        index,
        sector: sector.readBigUInt64LE(0),
        nrSectors,
        flags,
        offset: pos,
      };

      // The mark text sits in the same sector right behind the header: a short
      // mark fits in what is left of the sector and has no payload of its own.
      if (flags & LOG_FLAG.MARK && dataLen > 0) {
        const end = Math.min(ENTRY_HEADER_BYTES + dataLen, sectorSize);
        entry.mark = sector.toString('utf8', ENTRY_HEADER_BYTES, end).replace(/\0+$/, '');
      }

      entries.push(entry);
      pos += sectorSize;

      // The payload follows, sized by nrSectors. A DISCARD has none: there is
      // nothing to write, only the intent to throw a range away.
      if (nrSectors > 0n && !(flags & LOG_FLAG.DISCARD)) {
        pos += Number(nrSectors) * sectorSize;
      }
    }

    return { sectorSize, declaredEntries, entries, truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * Crash points — the places where the power could have gone.
 *
 * Mode `barriers`: every FLUSH and every FUA, plus every mark the workload
 * placed. These are the boundaries at which the device was obliged to have
 * carried the preceding writes to the medium, so they are states the disk can
 * genuinely be found in if the drive honours flushes.
 *
 * What the mode does NOT cover: reorderings inside the window between two
 * barriers. Between two flushes a device may commit any subset in any order,
 * and there are 2^k of those. The report has to say so out loud rather than
 * leave it unsaid — otherwise the tool becomes the thing it argues against:
 * a green run passing itself off as proof.
 */
export function crashPoints(log: ParsedLog, mode: 'barriers' | 'all'): number[] {
  const points: number[] = [];
  for (const entry of log.entries) {
    if (mode === 'all') {
      points.push(entry.index);
      continue;
    }
    if (hasFlag(entry, LOG_FLAG.FLUSH) || hasFlag(entry, LOG_FLAG.FUA) || hasFlag(entry, LOG_FLAG.MARK)) {
      points.push(entry.index);
    }
  }
  return points;
}
