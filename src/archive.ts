import { mediaReferences } from './media-reference.ts';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { Readable, Transform } from 'node:stream';
import { createZstdDecompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ZstdFrameGuard } from './zstd-frame.ts';
import { classifyMedia } from './extract.ts';
import type { CommentRecord, ThreadSnapshot } from './extract.ts';
import { postId, subredditName, validateObservation } from './domain.ts';
import type { PostObservation, Availability } from './domain.ts';
import type { ReaderStore } from './store.ts';

function seconds(value: unknown, required = true): number | undefined {
  if ((value === undefined || value === null) && !required) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 1000))) throw new Error('Invalid UTC timestamp');
  return Math.round(value * 1000);
}
function availability(row: Record<string, any>, body: string | undefined): Availability {
  const meta = row._meta;
  if (body?.trim() === '[deleted]') return 'deleted';
  if (body?.trim() === '[removed]' || meta?.was_deleted_later === true) return 'removed';
  return 'available';
}
export function archivePost(row: Record<string, any>, name: string, exportId: string, observedAt: number): PostObservation {
  if (subredditName(String(row.subreddit)) !== name) throw new Error('Wrong subreddit');
  if (typeof row.id !== 'string' || typeof row.title !== 'string') throw new Error('Missing post identity/title');
  const id = postId(row.id);
  const body = typeof row.selftext === 'string' ? row.selftext : undefined;
  const media = classifyMedia({ self: row.is_self === true, body, outbound: typeof row.url === 'string' ? row.url : null, video: row.is_video === true, image: row.is_gallery === true });
  return validateObservation({ id, subreddit: name, title: row.title,
    permalink: typeof row.permalink === 'string' ? row.permalink : `/r/${name}/comments/${id.slice(3)}/`,
    created: { epochMs: seconds(row.created_utc)!, precisionMs: 1000 },
    source: 'archive', exportId, observedAt, capturedAt: seconds(row.retrieved_on, false),
    body, media, outbound:typeof row.url==='string'?row.url:undefined, attachments: mediaReferences([typeof row.url === 'string' ? row.url : null]), availability: availability(row, body) });
}

export interface ImportProgress { id: string; filename: string; state: 'running' | 'done' | 'paused'; lines: number; accepted: number; added: number; omitted: number; filtered: number; bytes: number; reason: string | null }
export class ArchiveImporter {
  private store: ReaderStore;
  private abort: AbortController | null = null;
  private completion: Promise<void> | null = null;
  private source:string|null=null;
  progress: ImportProgress | null = null;
  constructor(store: ReaderStore) { this.store = store; }
  stop() { this.abort?.abort(); }
  async close() { this.stop(); await this.completion; }
  async stopSource(name:string) {if(this.source===name)await this.close();}
  async clear() {await this.close();this.progress=null;this.source=null;}
  async clearSource(name:string) {if(this.source===name){await this.close();this.progress=null;this.source=null;}}
  async run(input: Readable, options: { subreddit: string; filename: string; size: number; modified: number; afterMs?: number; beforeMs?: number; postIds?: string[] }) {
    if (this.abort) throw new Error('Another import is running');
    this.store.assertStorageAvailable();
    const name = subredditName(options.subreddit);
    if (!this.store.followedSources().includes(name)) throw new Error('Follow this subreddit first');
    if (!Number.isSafeInteger(options.size) || options.size < 1) throw new Error('Choose a nonempty archive file');
    if (!/\.(jsonl|ndjson)(\.zst)?$/i.test(options.filename) && !/\.zst$/i.test(options.filename)) throw new Error('Expected JSONL, NDJSON or Zstandard-compressed JSONL');
    const selected = new Set((options.postIds ?? []).map(postId));
    if (selected.size > 10) throw new Error('Select at most 10 posts for archive comments');
    const generation = this.store.generation;
    const id = randomUUID();
    const startedAt = Date.now();
    const controller = this.abort = new AbortController();this.source=name;
    const progress = this.progress = { id, filename: options.filename.slice(0, 200), state: 'running', lines: 0, accepted: 0, added: 0, omitted: 0, filtered: 0, bytes: 0, reason: null } as ImportProgress;
    let complete!:()=>void;
    this.completion=new Promise<void>(resolve=>{complete=resolve;});
    const samples = new Map<string, Map<string, CommentRecord>>();
    const sampleOmissions = new Map<string,number>();
    let sampleCharacters=0;
    const omitComment=(id:string)=>{sampleOmissions.set(id,(sampleOmissions.get(id)??0)+1);progress.omitted++;};
    let batch: PostObservation[] = [];
    const flush = async () => {
      controller.signal.throwIfAborted();
      if (batch.length) { progress.added += this.store.importArchiveBatch(generation, batch); batch = []; }
      await yieldNow();
    };
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      progress.bytes += chunk.length;
      callback(progress.bytes > options.size ? new Error('Input size changed or exceeds declared size') : null, chunk);
    } });
    const decoded = /\.zst$/i.test(options.filename) ? createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: 27 } }) : new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } });
    // Pipeline forwards truncation/decompression errors and bounds backpressure.
    let pipelineError: unknown;
    const piping = (/\.zst$/i.test(options.filename) ? pipeline(input,meter,new ZstdFrameGuard(),decoded,{signal:controller.signal}) : pipeline(input,meter,decoded,{signal:controller.signal})).catch(error => { pipelineError = error; });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    const line = (value: string) => {
      progress.lines++;
      if (!value.trim()) return;
      try {
        const row = JSON.parse(value);
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Not a record');
        if (typeof row.subreddit !== 'string') throw new Error('Missing subreddit');
        if (subredditName(row.subreddit) !== name) { progress.filtered++; return; }
        const createdMs = seconds(row.created_utc)!;
        if ((options.afterMs !== undefined && createdMs < options.afterMs) || (options.beforeMs !== undefined && createdMs >= options.beforeMs)) { progress.filtered++; return; }
        if (typeof row.body === 'string' && row.link_id) {
          const parentPost = postId(row.link_id);
          if (!selected.has(parentPost)||this.store.isPostExcluded(parentPost)) { progress.filtered++; return; }
          if (typeof row.id !== 'string' || !/^(t1_)?[a-z0-9]{1,16}$/.test(row.id) || row.body.length > 1_000_000) throw new Error('Invalid comment');
          const commentId = row.id.startsWith('t1_') ? row.id : `t1_${row.id}`;
          const state = availability(row, row.body);
          const parent = typeof row.parent_id === 'string' && /^(t1|t3)_[a-z0-9]+$/.test(row.parent_id) ? row.parent_id : null;
          const comment: CommentRecord = { id: commentId, postId: parentPost, parentId: parent, ancestry: parent ? 'known' : 'unresolved', body: state === 'available' ? row.body : '', availability: state, createdMs };
          const sample = samples.get(parentPost) ?? new Map<string, CommentRecord>();
          const previous=sample.get(commentId);
          if(sampleCharacters+comment.body.length-(previous?.body.length??0)>4_000_000){omitComment(parentPost);return;}
          sampleCharacters+=comment.body.length-(previous?.body.length??0);
          sample.set(commentId, comment);
          // Keep at most 300 earliest records per selected post, regardless of file order.
          if (sample.size > 300) {
            const last = [...sample.values()].sort((a,b) => b.createdMs! - a.createdMs! || b.id.localeCompare(a.id))[0]!;
            sample.delete(last.id);
            sampleCharacters-=last.body.length;omitComment(parentPost);
          }
          samples.set(parentPost, sample); progress.accepted++;
        } else { const post=archivePost(row,name,id,startedAt);if(this.store.isPostExcluded(post.id)){progress.filtered++;return;}batch.push(post); progress.accepted++; }
      } catch { progress.omitted++; }
    };
    try {
      for await (const chunk of decoded) {
        controller.signal.throwIfAborted();
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          if (newline > 1_000_000) throw new Error('A record exceeds the one-MB line limit');
          line(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          if (batch.length >= 50 || progress.lines % 50 === 0) await flush();
        }
        if (pending.length > 1_000_000) throw new Error('A record exceeds the one-MB line limit');
      }
      pending += decoder.decode();
      if (pending.trim()) line(pending);
      await piping;
      if (pipelineError) throw pipelineError;
      if (progress.bytes !== options.size) throw new Error('Input was truncated or changed');
      await flush();
      for (const [postId, sample] of samples) {
        const post = this.store.getPost(postId, 'archive');
        if (!post || post.source !== 'archive' || post.availability !== 'available') { progress.omitted += sample.size; continue; }
        const ordered = [...sample.values()].sort((a,b) => a.createdMs! - b.createdMs! || a.id.localeCompare(b.id));
        const selectedComments = new Map(ordered.slice(0,100).map(comment => [comment.id, comment]));
        for (const comment of [...selectedComments.values()]) {
          let parent = comment.parentId; const seen = new Set<string>();
          while (parent?.startsWith('t1_') && sample.has(parent) && !seen.has(parent)) {
            seen.add(parent); const ancestor = sample.get(parent)!; selectedComments.set(parent, ancestor); parent = ancestor.parentId;
          }
        }
        const comments = [...selectedComments.values()].map(comment => ({ ...comment,
          ancestry: comment.parentId === postId || (comment.parentId && selectedComments.has(comment.parentId)) ? 'known' as const : 'unresolved' as const }));
        const snapshot: ThreadSnapshot = { id: randomUUID(), postId, source: 'archive', exportId: id, capturedAt: null, observedAt: startedAt,
          sort: 'chronological', body: post.body, availability: post.availability, comments, omitted: Math.max(0, sample.size - comments.length)+(sampleOmissions.get(postId)??0),
          sample: 'Earliest 100 of up to 300 retained comments, with retained ancestors; four-million-character import sample limit; file may be incomplete, capture time unknown' };
        this.store.saveSnapshot(generation, snapshot);
      }
      progress.state = 'done'; progress.reason = 'Selected file processed; this does not establish complete historical coverage';
    } catch (error) {
      progress.state = 'paused'; progress.reason = error instanceof Error ? error.message : 'Import interrupted';
      controller.abort(); input.destroy(); decoded.destroy(); await piping;
    } finally {
      try {
        const previous = this.store.getSetting<unknown[]>('imports') ?? [];
        if (generation === this.store.generation) this.store.setSetting('imports', [{ ...progress, subreddit: name, size: options.size, modified: options.modified }, ...previous].slice(0,20));
      } catch (error) {
        progress.state='paused';progress.reason=error instanceof Error?error.message:'Could not save import progress';
        throw error;
      } finally {
        this.abort = null;
        complete();this.completion=null;
      }
    }
    return progress;
  }
}
