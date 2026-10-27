export interface ArchiveFetchState {
  id: string;
  subreddit: string;
  afterMs: number;
  beforeMs: number;
  cursorMs: number;
  boundaryIds: string[];
  widePage: boolean;
  state: 'running' | 'paused' | 'done';
  phase: 'fetching' | 'media';
  dataComplete: boolean;
  mediaIds: string[];
  pages: number;
  observed: number;
  added: number;
  omitted: number;
  excluded: number;
  oldestMs: number | null;
  newestMs: number | null;
  reason: string | null;
  notBefore: number | null;
  createdAt: number;
  updatedAt: number;
}

/** User dates include the entire UTC end date; API bounds use an exclusive end. */
export function archiveRange(from: unknown, to: unknown): { afterMs: number; beforeMs: number } {
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose valid archive dates');
    const ms = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value || ms < 0) throw new Error('Choose valid archive dates');
    return ms;
  };
  const afterMs = from === '' || from === undefined ? 0 : parse(from);
  const beforeMs = parse(to) + 86_400_000;
  if (afterMs >= beforeMs || beforeMs > Math.floor(Date.now()/86_400_000)*86_400_000+86_400_000) throw new Error('Choose an archive range ending today or earlier, with From before To');
  return { afterMs, beforeMs };
}
