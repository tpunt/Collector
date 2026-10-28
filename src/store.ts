import { DatabaseSync, backup } from 'node:sqlite';
import {initializeSchema,recoverInterruptedWork,rebuildSearch,SCHEMA_VERSION} from './schema.ts';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { postId, redditUrl, subredditName, validateObservation } from './domain.ts';
import type { Availability, MediaKind, MediaFilter, PostObservation } from './domain.ts';
import { historyMonths, historyLowerBound, historyRank } from './history-window.ts';
import type { HistoryMonths } from './history-window.ts';
import type { ThreadSnapshot } from './extract.ts';
import type { ArchiveFetchState } from './archive-fetch-state.ts';
import type { MediaReference } from './media-reference.ts';
import {postMediaReferences,isGallery,completeCollection} from './media-reference.ts';
import {mediaKey} from './media-key.ts';
import { DEFAULT_STORAGE_CAP, storageCap, StorageLimitError } from './storage-limit.ts';
import type { StorageStatus } from './storage-limit.ts';
import {normalizeText} from './search.ts';
import {feedCursor} from './feed-cursor.ts';
import {ARCHIVE_JOIN,POST_BODY} from './reader-fields.ts';
import type {CleanupCriteria} from './library-storage.ts';
import {authorIdentity} from './authors.ts';
import type {Author} from './authors.ts';

// A listing can omit fields that an archive already saved. Compose the reader
// view without relabelling archive evidence as a new live observation.
const ARCHIVE_MEDIA_MATCH="(o.outbound IS NULL OR o.outbound=archived.outbound)";
const POST_MEDIA=`coalesce(o.media,CASE WHEN ${ARCHIVE_MEDIA_MATCH} THEN archived.media END)`;
const POST_ATTACHMENTS=`coalesce(o.attachments,CASE WHEN ${ARCHIVE_MEDIA_MATCH} THEN archived.attachments END)`;
const POST_OUTBOUND='coalesce(o.outbound,archived.outbound)';
const POST_AUTHOR=`coalesce((SELECT author FROM observation_authors WHERE post_id=p.id AND source_key=o.source_key),
  (SELECT a.author FROM observation_authors a JOIN observations evidence ON evidence.post_id=a.post_id AND evidence.source_key=a.source_key
    WHERE a.post_id=p.id AND evidence.source='archive' ORDER BY evidence.observed_at DESC,evidence.source_key DESC LIMIT 1))`;
const AUTHOR_FAVOURITE=`EXISTS(SELECT 1 FROM favourite_users fu WHERE fu.platform=json_extract(${POST_AUTHOR},'$.platform') AND fu.user_id=json_extract(${POST_AUTHOR},'$.id'))`;

const snapshotContent=(value:ThreadSnapshot)=>JSON.stringify([value.postId,value.source,value.exportId,value.capturedAt,value.sort,value.body,value.availability,
  value.comments.map(comment=>[comment.id,comment.postId,comment.parentId,comment.ancestry,comment.body,comment.availability,comment.createdMs]),value.omitted,value.sample]);

export class StaleGenerationError extends Error {
  constructor() { super('Content was cleared; discard this late result'); }
}
export interface HistoryTarget {
  id: string;
  subreddit: string;
  lowerMs: number | null;
  upperMs: number;
  continuation: string | null;
  lastPage: string | null;
  anchorMs: number;
  dependsOn: string | null;
  completion: 'date-boundary' | 'listing-end' | 'prior-scan' | null;
  observedCount: number;
  omissionCount: number;
  oldestMs: number | null;
  status: 'queued' | 'paused' | 'done' | 'cancelled';
  reason: string | null;
  boundary: { olderIds: string[]; batches: number; lastSignature: string | null; repeats: number };
}
export interface StoredPost {
  author:Author|null;
  favourite:boolean;
  favouriteUser:boolean;
  readContext:string;
  readAt:number|null;
  id: string;
  subreddit: string;
  permalink: string;
  title: string;
  createdMs: number;
  precisionMs: number;
  body: string | null;
  bodySync:{status:'pending'|'fetching'|'ready'|'failed';reason:string|null}|null;
  media: MediaKind[];
  attachments: MediaReference[];
  mediaDiscoveryComplete:boolean;
  outbound: string|null;
  availability: Availability;
  source: 'live' | 'archive';
  exportId: string | null;
  observedAt: number;
  capturedAt: number | null;
}
export interface MediaSyncState {
  status: 'pending' | 'downloading' | 'ready' | 'failed' | 'unavailable';
  reason: string | null;
}
export interface OfflineMediaCounts { total:number; ready:number; pending:number; failed:number; unavailable:number }
export interface FeedSyncSummary {
  state:'never'|'running'|'incomplete'|'complete'|'gaps';
  lastSuccessAt:number|null;
  lastCompletedAt:number|null;
  startedAt:number|null;
  reason:string|null;
}
export interface FeedSource {
  text:{total:number;ready:number;pending:number;failed:number};
  name: string;
  postCount: number;
  historyMonths: HistoryMonths;
  historyTarget: HistoryTarget | null;
  oldestMs: number | null;
  newestMs: number | null;
  liveCount: number;
  archiveCount: number;
  sync:FeedSyncSummary;
}

export class ReaderStore {
  private db: DatabaseSync;
  private externalStorageBytes = () => 0;
  compactionWarning: string | null = null;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.function('normalize_text',{deterministic:true},text=>normalizeText(String(text??'')));
      initializeSchema(this.db);recoverInterruptedWork(this.db);
      this.db.function('has_media_reference',(outbound,attachments,kind)=>Number(
        (kind==='image'||kind==='video')&&postMediaReferences(outbound===null?null:String(outbound),JSON.parse(String(attachments??'[]')))
          .some(reference=>reference.kind===kind)));
    }
    catch(error){this.db.close();throw error;}
  }

  close(): void { this.db.close(); }
  async snapshot(path:string){await backup(this.db,path);}
  /** Called only with a fully authenticated, schema-validated staged backup. */
  replaceFrom(path:string,portable=true){
    const generation=this.generation,revision=this.contentRevision,limit=this.storageLimit,offline=this.getSetting('offlineMode');
    this.db.prepare('ATTACH DATABASE ? AS restored').run(path);
    try{
      this.transaction(()=>{
        this.db.exec('PRAGMA defer_foreign_keys=ON');
        const tables=this.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'search_*'").all().map(row=>String(row.name));
        this.db.exec('DELETE FROM search_text');
        for(const table of tables)this.db.exec(`DELETE FROM main."${table}"`);
        for(const table of tables)this.db.exec(`INSERT INTO main."${table}" SELECT * FROM restored."${table}"`);
        rebuildSearch(this.db);
        const restoredGeneration=this.generation,nextGeneration=Math.max(generation,restoredGeneration)+1;
        const resume=this.getSetting<{generation:number}>('offlineResume');
        this.db.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(nextGeneration);
        this.db.prepare("UPDATE metadata SET value=? WHERE key='content_revision'").run(revision+1);
        if(!portable&&resume?.generation===restoredGeneration)this.setSetting('offlineResume',{...resume,generation:nextGeneration});
        else this.db.exec("DELETE FROM settings WHERE key='offlineResume'");
        if(portable){this.db.exec("DELETE FROM settings WHERE key IN ('account','accessPause')");this.setStorageLimit(limit);}
        // Network permission belongs to this running app, even when content rolls back.
        if(offline!==null)this.setSetting('offlineMode',offline);else this.db.prepare("DELETE FROM settings WHERE key='offlineMode'").run();
      });
      recoverInterruptedWork(this.db);
    }finally{this.db.exec('DETACH DATABASE restored');}
    if(portable)this.compactContent('Library restored');
  }
  validateBackup(path:string,allowPrevious=false){
    const db=new DatabaseSync(path,{readOnly:true});
    try{
      const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),previous=allowPrevious&&[3,4].includes(version);
      const schema="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",order=' ORDER BY type,name';
      const exclusions=(previous?" AND name NOT IN ('observation_authors','observation_author_identity','favourite_posts','favourite_users')":'')+(previous&&version===3?" AND name NOT GLOB 'search_*'":'');
      if(JSON.stringify(db.prepare(schema+order).all())!==JSON.stringify(this.db.prepare(schema+exclusions+order).all())||
        ![SCHEMA_VERSION,...(previous?[3,4]:[])].includes(version)||
        Number(db.prepare('PRAGMA application_id').get()!.application_id)!==Number(this.db.prepare('PRAGMA application_id').get()!.application_id))throw new Error('Backup schema is not compatible with this app version');
      if(db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Backup database integrity check failed');
      for(const row of db.prepare('SELECT * FROM observations JOIN posts ON posts.id=observations.post_id').iterate())validateObservation({
        id:String(row.id),subreddit:String(row.subreddit),permalink:String(row.permalink),title:row.title as string,
        created:{epochMs:Number(row.created_ms),precisionMs:Number(row.precision_ms)},source:row.source as 'live'|'archive',exportId:row.export_id as string??undefined,
        observedAt:Number(row.observed_at),body:row.body as string??undefined,availability:row.availability as Availability,
        media:row.media?JSON.parse(String(row.media)):undefined,attachments:row.attachments?JSON.parse(String(row.attachments)):undefined,outbound:row.outbound as string??undefined});
      for(const row of db.prepare('SELECT * FROM media_evidence JOIN posts ON posts.id=media_evidence.post_id').iterate())validateObservation({id:String(row.id),subreddit:String(row.subreddit),permalink:String(row.permalink),title:'Media evidence',created:{epochMs:Number(row.created_ms),precisionMs:Number(row.precision_ms)},source:'live',observedAt:Number(row.observed_at),attachments:JSON.parse(String(row.attachments))});
      for(const row of db.prepare('SELECT name FROM feeds').iterate())if(subredditName(String(row.name))!==row.name)throw new Error('Invalid backup feed identity');
      for(const row of db.prepare('SELECT * FROM excluded_posts').iterate())if(postId(String(row.post_id))!==row.post_id||subredditName(String(row.subreddit))!==row.subreddit||!Number.isSafeInteger(row.deleted_at)||Number(row.deleted_at)<0)throw new Error('Invalid backup exclusion');
      for(const row of db.prepare('SELECT * FROM posts').iterate()){
        const identity=validateObservation({id:String(row.id),subreddit:String(row.subreddit),permalink:String(row.permalink),title:'Stored post',created:{epochMs:Number(row.created_ms),precisionMs:Number(row.precision_ms)},source:'live',observedAt:0});
        if(identity.id!==row.id||identity.subreddit!==row.subreddit||identity.permalink!==row.permalink)throw new Error('Invalid backup post identity');
        const post=this.readPost(db,String(row.id),undefined,!previous),expected=new Set((post?.attachments??[]).map(mediaKey));
        const owned=db.prepare('SELECT key FROM post_media WHERE post_id=?').all(String(row.id)).map(row=>String(row.key));
        if(owned.length!==expected.size||owned.some(key=>!expected.has(key)))throw new Error('Backup media ownership does not match its post references');
      }
      for(const row of db.prepare('SELECT post_id,data FROM thread_snapshots').iterate()){
        const snapshot=JSON.parse(String(row.data));
        if(snapshot.postId!==row.post_id||!Array.isArray(snapshot.comments)||typeof snapshot.sample!=='string'||typeof snapshot.sort!=='string'||
          snapshot.body!==null&&typeof snapshot.body!=='string'||snapshot.comments.some((comment:any)=>!/^t1_[a-z0-9]+$/.test(comment.id)||comment.postId!==row.post_id||typeof comment.body!=='string'))throw new Error('Invalid discussion in backup');
      }
      const cap=db.prepare("SELECT value FROM settings WHERE key='maxStoredBytes'").get();if(cap)storageCap(JSON.parse(String(cap.value)));
      if(!previous){
        for(const row of db.prepare('SELECT author FROM observation_authors').iterate()){const author=JSON.parse(String(row.author));if(author!==null)authorIdentity(author);}
        for(const row of db.prepare('SELECT * FROM favourite_users').iterate())authorIdentity({platform:row.platform,id:row.user_id,name:row.display_name});
      }
      return {schema:version,posts:Number(db.prepare('SELECT count(*) AS n FROM posts').get()!.n),keys:new Set(db.prepare('SELECT DISTINCT key FROM post_media').all().map(row=>String(row.key)))};
    }finally{db.close();}
  }
  setExternalStorageUsage(readBytes:()=>number) { this.externalStorageBytes=readBytes; }
  get storageLimit():number { return this.getSetting<number>('maxStoredBytes') ?? DEFAULT_STORAGE_CAP; }
  setStorageLimit(value:unknown) { this.setSetting('maxStoredBytes',storageCap(value)); }
  private databaseBytes():number { return Number(this.db.prepare('PRAGMA page_count').get()!.page_count) * Number(this.db.prepare('PRAGMA page_size').get()!.page_size); }
  get storage():StorageStatus {
    const usedBytes=this.databaseBytes()+this.externalStorageBytes(),limitBytes=this.storageLimit;
    return {usedBytes,limitBytes,percentUsed:usedBytes/limitBytes*100,full:usedBytes>=limitBytes};
  }
  assertStorageAvailable() { if(this.storage.full)throw new StorageLimitError(); }
  assertStorageFits(extraBytes=0) { if(this.storage.usedBytes+extraBytes>this.storageLimit)throw new StorageLimitError(); }
  get generation(): number {
    return Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'generation'").get()!.value);
  }
  addSubreddit(input: string): string {
    const name = subredditName(input);
    this.db.prepare('INSERT OR IGNORE INTO feeds(name) VALUES (?)').run(name);
    return name;
  }
  listSubreddits(): string[] {
    return this.db.prepare('SELECT name FROM feeds ORDER BY name').all().map(row => String(row.name));
  }

  createTarget(input: { subreddit: string; lowerMs?: number; upperMs: number }): string {
    const name=subredditName(input.subreddit);this.requireSubreddit(name);
    if(!Number.isSafeInteger(input.upperMs)||input.upperMs<0||
      (input.lowerMs!==undefined&&(!Number.isSafeInteger(input.lowerMs)||input.lowerMs<0||input.lowerMs>input.upperMs)))throw new Error('Invalid history target');
    const id=randomUUID();
    this.db.prepare('INSERT INTO targets(id,subreddit,lower_ms,upper_ms,anchor_ms) VALUES (?,?,?,?,?)').run(id,name,input.lowerMs??null,input.upperMs,input.upperMs);
    return id;
  }

  getTarget(id: string): HistoryTarget | null {
    const row = this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: String(row.id), subreddit: String(row.subreddit),
      lowerMs: row.lower_ms as number | null, upperMs: Number(row.upper_ms),
      continuation: row.continuation as string | null, lastPage: row.last_page as string | null, anchorMs:Number(row.anchor_ms), dependsOn:row.depends_on as string | null, completion: row.completion as HistoryTarget['completion'], observedCount: Number(row.observed_count),
      omissionCount: Number(row.omission_count), oldestMs: row.oldest_ms as number | null,
      status: row.status as HistoryTarget['status'], reason: row.reason as string | null,
      boundary: JSON.parse(String(row.boundary)) as HistoryTarget['boundary'],
    };
  }
  listUnfinishedTargets(): HistoryTarget[] {
    return this.db.prepare("SELECT id FROM targets WHERE status IN ('queued', 'paused') ORDER BY rowid")
      .all().map(row => this.getTarget(String(row.id))!);
  }
  hasBatch(targetId: string, signature: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM target_batches WHERE target_id = ? AND signature = ?').get(targetId, signature)); }

  /** A page and its checkpoint either both commit or neither does. */
  commitBatch(input: {
    generation: number;
    targetId: string;
    observations: PostObservation[];
    continuation: string | null;
    omissions?: number;
    status?: HistoryTarget['status'];
    reason?: string;
    boundary?: HistoryTarget['boundary'];
    batchKey?: string;
    fromHead?: boolean;
    pageUrl?: string;
    completion?: HistoryTarget['completion'];
  }): { newPosts: number; newTargetPosts: number } {
    return this.contentTransaction(() => {
      if (input.generation !== this.generation) throw new StaleGenerationError();
      const target = this.getTarget(input.targetId);
      if (!target || ['done', 'cancelled'].includes(target.status)) throw new Error('Target is no longer active');
      if (input.continuation !== null) {
        const next = redditUrl(input.continuation);
        if (next.hash || !new RegExp(`^/r/${target.subreddit}/new/?$`, 'i').test(next.pathname)) {
          throw new Error('Continuation must be a captured Next URL for this subreddit’s new listing');
        }
      }
      if(input.pageUrl){const page=redditUrl(input.pageUrl);if(page.hostname!=='old.reddit.com'||!new RegExp(`^/r/${target.subreddit}/new/?$`,'i').test(page.pathname))throw new Error('Invalid committed listing URL');}
      if(input.completion&&!['date-boundary','listing-end','prior-scan'].includes(input.completion))throw new Error('Invalid completion evidence');
      if((input.status==='done')!==Boolean(input.completion))throw new Error('Finished scans require explicit completion evidence');
      const omissions = input.omissions ?? 0;
      if (!Number.isSafeInteger(omissions) || omissions < 0) throw new Error('Invalid omission count');
      if (input.status && !['queued', 'paused', 'done', 'cancelled'].includes(input.status)) throw new Error('Invalid target state');
      let newPosts = 0;
      let newTargetPosts = 0;
      let oldest = target.oldestMs;
      for (const record of input.observations) {
        const observation = validateObservation(record);
        if (observation.source !== 'live') throw new Error('Archive imports cannot advance live history targets');
        if (observation.subreddit !== target.subreddit) throw new Error('Observation belongs to another subreddit');
        if (this.isPostExcluded(observation.id)) continue;
        newPosts += this.writePost(observation);
        newTargetPosts += Number(this.db.prepare('INSERT OR IGNORE INTO target_posts VALUES (?, ?)')
          .run(target.id, observation.id).changes);
        oldest = Math.min(oldest ?? Infinity, observation.created.epochMs);
      }
      const newBatch = !input.batchKey || Boolean(this.db.prepare('INSERT OR IGNORE INTO target_batches VALUES (?, ?)').run(target.id, input.batchKey).changes);
      this.db.prepare(`UPDATE targets SET continuation = ?, observed_count = observed_count + ?,
        omission_count = omission_count + ?, oldest_ms = ?, status = ?, reason = ?, boundary = ?,
        last_page=coalesce(?,last_page),completion=?,started_at_head=max(started_at_head,?) WHERE id = ?`)
        .run(input.continuation, newTargetPosts, newBatch ? omissions : 0, oldest, input.status ?? 'queued', input.reason ?? null,
          JSON.stringify(input.boundary ?? target.boundary),input.pageUrl??null,input.completion??null,Number(input.fromHead??false),target.id);
      if(input.status==='done'&&input.completion==='date-boundary'&&target.lowerMs!==null&&this.db.prepare('SELECT started_at_head FROM targets WHERE id = ?').get(target.id)?.started_at_head){
        this.db.prepare(`UPDATE targets SET anchor_ms = ? WHERE id = (SELECT history_target_id FROM feeds WHERE name = ?)
          AND anchor_ms >= ? AND anchor_ms <= ?`).run(target.upperMs,target.subreddit,target.lowerMs,target.upperMs);
      }
      if(input.status==='done'&&input.completion==='date-boundary'&&target.lowerMs!==null&&this.db.prepare('SELECT started_at_head FROM targets WHERE id = ?').get(target.id)?.started_at_head){
        const pref=this.getHistoryPreference(target.subreddit),goal=pref.targetId?this.getTarget(pref.targetId):null;
        // A fresh scan may itself cover the entire requested window after a long
        // absence. Do not jump to an old checkpoint and skip the intervening gap.
        if(goal&&goal.id!==target.id&&['queued','paused'].includes(goal.status)&&goal.lowerMs!==null&&target.lowerMs<=goal.lowerMs&&target.upperMs>=goal.upperMs){
          this.db.prepare('INSERT OR IGNORE INTO target_posts SELECT ?,post_id FROM target_posts WHERE target_id = ?').run(goal.id,target.id);
          const scan=this.getTarget(target.id)!;
          this.db.prepare(`UPDATE targets SET status='done',completion='date-boundary',reason='Selected date boundary reached by the fresh scan; coverage may contain gaps',
            anchor_ms=?,observed_count=(SELECT count(*) FROM target_posts WHERE target_id=?),omission_count=omission_count+?,oldest_ms=?,last_page=? WHERE id=?`)
            .run(target.upperMs,goal.id,scan.omissionCount,Math.min(goal.oldestMs??Infinity,scan.oldestMs??Infinity)===Infinity?null:Math.min(goal.oldestMs??Infinity,scan.oldestMs??Infinity),scan.lastPage,goal.id);
        }
      }
      return { newPosts, newTargetPosts };
    });
  }

  fileImportSource(generation:number,input:string,fingerprint:string,legacy?:string):string {
    const name=subredditName(input);if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error('Invalid file identity');
    return this.contentTransaction(()=>{
      if(generation!==this.generation)throw new StaleGenerationError();
      const key='fileImport:'+fingerprint,existing=this.getSetting<{subreddit:string;exportId:string}>(key);
      if(existing?.subreddit===name&&typeof existing.exportId==='string'&&existing.exportId.length<=200)return existing.exportId;
      const exportId=legacy&&/^[a-f0-9-]{36}$/.test(legacy)?legacy:'file:'+fingerprint;
      this.setSetting(key,{subreddit:name,exportId});return exportId;
    });
  }

  /** Storage boundary for a future file importer; never moves a live checkpoint. */
  importArchiveBatch(generation: number, records: PostObservation[]): number {
    return this.contentTransaction(() => {
      if (generation !== this.generation) throw new StaleGenerationError();
      let newPosts = 0;
      for (const record of records) {
        const observation = validateObservation(record);
        if (observation.source !== 'archive') throw new Error('Expected archive provenance');
        newPosts += this.writePost(observation);
      }
      return newPosts;
    });
  }

  archiveFetch(id:string):ArchiveFetchState|null {
    const row=this.db.prepare('SELECT data FROM archive_fetches WHERE id=?').get(id);
    return row?JSON.parse(String(row.data)):null;
  }
  archiveFetches():ArchiveFetchState[] {
    return this.db.prepare('SELECT data FROM archive_fetches ORDER BY updated_ms DESC').all().map(row=>JSON.parse(String(row.data)));
  }
  saveArchiveFetch(job:ArchiveFetchState) {
    this.db.prepare('INSERT INTO archive_fetches VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_ms=excluded.updated_ms,data=excluded.data')
      .run(job.id,job.subreddit,job.updatedAt,JSON.stringify(job));
  }
  commitArchiveFetch(generation:number,revision:number,job:ArchiveFetchState,records:PostObservation[]) {
    this.contentTransaction(()=>{
      if(generation!==this.generation||revision!==this.sourceRevision(job.subreddit)||!this.archiveFetch(job.id))throw new StaleGenerationError();
      let added=0;
      for(const record of records){const observation=validateObservation(record);if(observation.source!=='archive'||observation.exportId!==job.id||observation.subreddit!==job.subreddit)throw new Error('Archive provenance mismatch');added+=this.writePost(observation);}
      this.saveArchiveFetch({...job,added:job.added+added});
    });
  }
  archiveMediaCounts(id:string):OfflineMediaCounts {
    const result:OfflineMediaCounts={total:0,ready:0,pending:0,failed:0,unavailable:0};
    for(const row of this.db.prepare(`SELECT m.status,count(*) AS n FROM media_sync m JOIN observations o ON o.post_id=m.post_id
      WHERE o.export_id=? GROUP BY m.status`).all(id)){
      const status=row.status==='downloading'?'pending':row.status as keyof Omit<OfflineMediaCounts,'total'>;
      result[status]+=Number(row.n);result.total+=Number(row.n);
    }
    return result;
  }

  getPost(input: string, source?: 'archive'): StoredPost | null {
    return this.readPost(this.db,input,source);
  }
  private readPost(db:DatabaseSync,input:string,source?:'archive',favourites=true):StoredPost|null {
    const row = db.prepare(`SELECT p.*, o.title, ${POST_BODY} AS body,${POST_MEDIA} AS media,${POST_ATTACHMENTS} AS attachments,${POST_OUTBOUND} AS outbound,o.availability,
      o.source, o.export_id, o.observed_at, o.captured_at,
      ${favourites?POST_AUTHOR:'NULL'} AS author_data,
      ${favourites?'EXISTS(SELECT 1 FROM favourite_posts WHERE post_id=p.id)':'0'} AS favourite,
      ${favourites?AUTHOR_FAVOURITE:'0'} AS favourite_user,
      (SELECT attachments FROM media_evidence WHERE post_id=p.id) AS discovered_attachments
      FROM posts p JOIN observations o ON o.post_id = p.id
      ${ARCHIVE_JOIN}
      WHERE p.id = ? AND (? IS NULL OR o.source = ?) ORDER BY (o.source = 'live') DESC, o.observed_at DESC, o.source_key DESC LIMIT 1`).get(postId(input), source ?? null, source ?? null);
    if (!row) return null;
    const availability = (row.live_availability ?? row.availability) as Availability;
    const attachments = availability === 'available' ? postMediaReferences(row.outbound as string|null,JSON.parse(String(row.discovered_attachments ?? row.attachments ?? '[]')) as MediaReference[]) : [];
    return {
      id: String(row.id), subreddit: String(row.subreddit), permalink: String(row.permalink), title: String(row.title),
      author:availability==='deleted'?null:JSON.parse(String(row.author_data??'null')),
      favourite:Boolean(row.favourite),favouriteUser:availability!=='deleted'&&Boolean(row.favourite_user),
      readContext:String(db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value)+':'+String(JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key=?').get('sourceRevision:'+String(row.subreddit))?.value??'0'))),
      readAt:(db.prepare('SELECT read_at FROM read_states WHERE post_id=?').get(String(row.id))?.read_at as number|undefined)??null,
      createdMs: Number(row.created_ms), precisionMs: Number(row.precision_ms),
      body: availability === 'available' ? row.body as string | null : null,
      bodySync:(db.prepare('SELECT status,reason FROM body_sync WHERE post_id=?').get(String(row.id)) as StoredPost['bodySync'])??null,
      media: availability === 'available' ? [...new Set<MediaKind>([...JSON.parse(String(row.media ?? '[]')), ...attachments.map(item=>item.kind==='image'?'Image' as const:'Video' as const)])] : [],
      attachments,
      mediaDiscoveryComplete:!isGallery(row.outbound as string|null)||completeCollection('reddit:'+String(row.id),attachments),
      outbound: availability === 'available'?row.outbound as string|null:null,
      availability, source: row.source as StoredPost['source'], exportId: row.export_id as string | null,
      observedAt: Number(row.observed_at), capturedAt: row.captured_at as number | null,
    };
  }
  mediaSync(input:string):MediaSyncState|null {
    const row=this.db.prepare('SELECT status,reason FROM media_sync WHERE post_id=?').get(postId(input));
    return row?{status:row.status as MediaSyncState['status'],reason:row.reason as string|null}:null;
  }
  setMediaSync(generation:number,input:string,status:MediaSyncState['status'],reason:string|null=null,session?:string) {
    if(generation!==this.generation)return;
    const changed=this.db.prepare('UPDATE media_sync SET status=?,reason=?,session=coalesce(?,session) WHERE post_id=?').run(status,reason,session??null,postId(input));
    if(changed.changes)this.db.prepare("UPDATE metadata SET value=value+1 WHERE key='media_sync_revision'").run();
  }
  get mediaSyncRevision():number {return Number(this.db.prepare("SELECT value FROM metadata WHERE key='media_sync_revision'").get()!.value);}
  get contentRevision():number {return Number(this.db.prepare("SELECT value FROM metadata WHERE key='content_revision'").get()!.value);}
  *readyMediaIds():Generator<string> {
    for(const row of this.db.prepare("SELECT post_id FROM media_sync WHERE status='ready'").iterate())yield String(row.post_id);
  }
  implementationLimitedMedia():string[] {
    return this.db.prepare("SELECT post_id FROM media_sync WHERE status='unavailable' AND (reason LIKE 'Complete gallery downloads%' OR reason LIKE '%per-file download limit%' OR reason LIKE '%media manifest%' OR reason LIKE '%single-file video representation%')").all().map(row=>String(row.post_id));
  }
  pendingMedia(source:string,session:string,limit=25):string[] {
    return this.db.prepare(`SELECT m.post_id FROM media_sync m JOIN posts p ON p.id=m.post_id
      WHERE p.subreddit=? AND (m.status IN ('pending','failed') OR (m.status='unavailable' AND m.reason LIKE 'Complete gallery downloads%')) AND (m.session IS NULL OR m.session<>?)
      ORDER BY p.created_ms DESC,p.id DESC LIMIT ?`).all(subredditName(source),session,limit).map(row=>String(row.post_id));
  }
  pendingBodies(source:string,excluded:ReadonlySet<string>=new Set(),limit=25):string[] {
    const result:string[]=[];
    for(const row of this.db.prepare(`SELECT p.id FROM posts p JOIN body_sync b ON b.post_id=p.id
      WHERE p.subreddit=? AND b.status IN ('pending','failed')
      ORDER BY p.created_ms DESC,p.id DESC`).iterate(subredditName(source))){
      const id=String(row.id);if(!excluded.has(id))result.push(id);if(result.length>=limit)break;
    }
    return result;
  }
  private missingBodyCount(source:string):number {return Number(this.db.prepare("SELECT count(*) AS n FROM body_sync b JOIN posts p ON p.id=b.post_id WHERE p.subreddit=? AND b.status<>'ready'").get(subredditName(source))!.n);}
  offlineText(source:string){
    const result={total:0,ready:0,pending:0,failed:0};
    for(const row of this.db.prepare('SELECT b.status,count(*) AS n FROM body_sync b JOIN posts p ON p.id=b.post_id WHERE p.subreddit=? GROUP BY b.status').all(subredditName(source))){const key=row.status==='fetching'?'pending':row.status as 'pending'|'ready'|'failed';result[key]+=Number(row.n);result.total+=Number(row.n);}return result;
  }
  bodySync(input:string):{status:'pending'|'fetching'|'ready'|'failed';reason:string|null}|null {
    const row=this.db.prepare('SELECT status,reason FROM body_sync WHERE post_id=?').get(postId(input));return row?row as unknown as {status:'pending'|'fetching'|'ready'|'failed';reason:string|null}:null;
  }
  setBodySync(generation:number,input:string,status:'pending'|'fetching'|'failed',reason:string|null=null){
    if(generation!==this.generation)return;this.db.prepare('UPDATE body_sync SET status=?,reason=? WHERE post_id=?').run(status,reason,postId(input));
    this.db.prepare("UPDATE metadata SET value=value+1 WHERE key='content_revision'").run();
  }
  offlineMedia(source:string):OfflineMediaCounts {
    const result:OfflineMediaCounts={total:0,ready:0,pending:0,failed:0,unavailable:0};
    for(const row of this.db.prepare('SELECT m.status,count(*) AS n FROM media_sync m JOIN posts p ON p.id=m.post_id WHERE p.subreddit=? GROUP BY m.status').all(subredditName(source))){
      const status=row.status==='downloading'?'pending':row.status as keyof Omit<OfflineMediaCounts,'total'>;
      result[status]+=Number(row.n);result.total+=Number(row.n);
    }
    return result;
  }

  feedSync(input:string):FeedSyncSummary {
    const name=subredditName(input),row=this.db.prepare('SELECT * FROM feed_sync WHERE subreddit=?').get(name);
    if(row){
      const media=this.offlineMedia(name),missing=['complete','gaps'].includes(String(row.state))&&(media.pending>0||media.failed>0||this.missingBodyCount(name)>0);
      return {state:missing?'incomplete':row.state as FeedSyncSummary['state'],lastSuccessAt:row.last_success_ms as number|null,
        lastCompletedAt:row.last_completed_ms as number|null,startedAt:Number(row.started_ms),
        reason:missing?'Some post content still needs saving; Resume to finish this feed':row.reason as string|null};
    }
    return {state:'never',lastSuccessAt:null,lastCompletedAt:null,startedAt:null,reason:null};
  }

  /** Resume only the current history goal's committed scope, never an abandoned wider goal. */
  resumeSyncPlan(input:string,now=Date.now()):{heads:string[];history:string[]}|null {
    const name=subredditName(input),row=this.db.prepare("SELECT targets FROM feed_sync WHERE subreddit=? AND state='incomplete'").get(name);
    if(!row)return null;
    const ids=JSON.parse(String(row.targets)) as string[],goal=this.getHistoryPreference(name).targetId;
    if(!goal||!ids.includes(goal)||ids.some(id=>{const target=this.getTarget(id);return target?.subreddit!==name||target.status==='cancelled';}))return null;
    const cutoff=historyLowerBound(this.getHistoryPreference(name).months,now),historyGoal=this.getTarget(goal)!;
    if(cutoff!==null&&historyGoal.anchorMs<cutoff)return null;
    // Catch up since the previous run's newest boundary while retaining all its
    // unfinished Next links. A long pause must not leave newer posts unvisited.
    return this.transaction(()=>{
      const upper=Math.max(...ids.map(id=>this.getTarget(id)!.upperMs));
      const head=this.createTarget({subreddit:name,lowerMs:Math.min(now,Math.max(upper,cutoff??0)),upperMs:now});
      for(const id of ids)if(this.getTarget(id)?.status!=='done')this.db.prepare('UPDATE targets SET depends_on=? WHERE id=?').run(head,id);
      this.db.prepare('UPDATE feeds SET requested_ms=? WHERE name=?').run(now,name);
      return {heads:[head],history:ids};
    });
  }
  beginFeedSync(input:string,targetIds:string[],now=Date.now()):string {
    const name=subredditName(input),ids=[...new Set(targetIds)];
    if(!ids.length||ids.some(id=>this.getTarget(id)?.subreddit!==name))throw new Error('Sync targets must belong to this feed');
    const id=randomUUID();
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO feed_sync(subreddit,run_id,targets,state,started_ms) VALUES (?,?,?,'running',?)
        ON CONFLICT(subreddit) DO UPDATE SET run_id=excluded.run_id,targets=excluded.targets,state='running',
        started_ms=excluded.started_ms,reason=NULL,gap_count=0`).run(name,id,JSON.stringify(ids),now);
    });return id;
  }
  noteSyncGap(input:string):void {this.db.prepare("UPDATE feed_sync SET gap_count=gap_count+1 WHERE subreddit=? AND state='running'").run(subredditName(input));}
  /** Called after this feed's queue drains. Saved pages alone are never success. */
  finishFeedSync(input:string,runId:string,now=Date.now()):void {
    const name=subredditName(input);
    this.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM feed_sync WHERE subreddit=? AND run_id=? AND state='running'").get(name,runId);if(!row)return;
      const targets=(JSON.parse(String(row.targets)) as string[]).map(id=>this.getTarget(id));
      const unfinished=targets.find(target=>target?.status!=='done');
      const media=this.offlineMedia(name),bodies=this.missingBodyCount(name);
      let reason=unfinished?.reason??(targets.some(target=>!target)?'A sync checkpoint is no longer available':null);
      let state:FeedSyncSummary['state']='complete';
      if(targets.some(target=>target?.status!=='done')||media.pending||media.failed||bodies){
        state='incomplete';reason??=bodies?`${bodies} post body/bodies still need saving; Resume to retry`:media.failed?`${media.failed} media post(s) failed to save; Resume to retry`:media.pending?`${media.pending} media post(s) still need saving; Resume to continue`:'Post collection is unfinished; Resume to continue';
      }else{
        const gaps:string[]=[];
        if(targets.some(target=>target?.completion==='listing-end'))gaps.push('Reached the end Reddit serves; full historical coverage could not be verified');
        const omitted=targets.reduce((sum,target)=>sum+(target?.omissionCount??0),0);
        if(omitted)gaps.push(`${omitted} post extraction(s) omitted`);
        if(media.unavailable)gaps.push(`${media.unavailable} media post(s) unavailable for offline saving`);
        const removed=Number(this.db.prepare(`SELECT count(DISTINCT p.id) AS n FROM target_posts t JOIN posts p ON p.id=t.post_id
          WHERE t.target_id IN (SELECT value FROM json_each(?)) AND p.live_availability IN ('removed','deleted')`).get(String(row.targets))!.n);
        const unavailablePosts=Math.max(removed,Number(row.gap_count));
        if(unavailablePosts)gaps.push(`${unavailablePosts} removed or deleted post(s)`);
        if(gaps.length){state='gaps';reason=gaps.join('. ');}else reason=null;
      }
      this.db.prepare(`UPDATE feed_sync SET state=?,reason=?,last_success_ms=CASE WHEN ?='complete' THEN ? ELSE last_success_ms END,
        last_completed_ms=CASE WHEN ? IN ('complete','gaps') THEN ? ELSE last_completed_ms END WHERE subreddit=? AND run_id=?`)
        .run(state,reason,state,now,state,now,name,runId);
    });
  }

  listFeed(limit = 100): StoredPost[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Invalid feed limit');
    return this.db.prepare(`SELECT id FROM posts WHERE EXISTS
      (SELECT 1 FROM observations WHERE post_id = posts.id) ORDER BY created_ms DESC, id DESC LIMIT ?`)
      .all(limit).map(row => this.getPost(String(row.id))!);
  }

  clearContent(): number {
    const generation=this.transaction(() => {
      this.db.exec(`DELETE FROM favourite_posts; DELETE FROM search_text; DELETE FROM read_states; DELETE FROM feed_sync; DELETE FROM archive_fetches; DELETE FROM thread_snapshots; UPDATE feeds SET history_target_id=NULL,requested_ms=NULL;
        UPDATE metadata SET value = value + 1 WHERE key = 'generation';
        DELETE FROM comment_states WHERE availability='available';
        DELETE FROM targets; DELETE FROM observations; DELETE FROM media_sync; DELETE FROM media_evidence; DELETE FROM post_media;
        DELETE FROM settings WHERE key='account' OR key GLOB 'fileImport:*';
        DELETE FROM posts WHERE live_availability IS NULL OR live_availability = 'available';`);
      // Followed namespaces are retained. Keep only identity/time/deletion state for removed posts,
      // so a subsequent old archive import cannot restore cleared, known-deleted content.
      return this.generation;
    });
    this.compactContent();
    return generation;
  }

  sourceRevision(input:string):number {return this.getSetting<number>('sourceRevision:'+subredditName(input))??0;}
  ownedMediaKeys(input:string):string[] {return this.db.prepare('SELECT DISTINCT m.key FROM post_media m JOIN posts p ON p.id=m.post_id WHERE p.subreddit=?').all(subredditName(input)).map(row=>String(row.key));}
  hasMediaOwner(key:string,owner?:string):boolean {return Boolean(owner?this.db.prepare('SELECT 1 FROM post_media WHERE key=? AND post_id=?').get(key,postId(owner)):this.db.prepare('SELECT 1 FROM post_media WHERE key=? LIMIT 1').get(key));}
  mediaOwners(key:string):{postId:string;feed:string}[]{return this.db.prepare('SELECT p.id AS postId,p.subreddit AS feed FROM post_media m JOIN posts p ON p.id=m.post_id WHERE m.key=? ORDER BY p.id').all(key) as unknown as {postId:string;feed:string}[];}
  storageFeeds(){return this.db.prepare(`SELECT f.name AS feed,f.subscribed,count(p.id) AS posts FROM feeds f LEFT JOIN posts p ON p.subreddit=f.name AND EXISTS(SELECT 1 FROM observations WHERE post_id=p.id) GROUP BY f.name ORDER BY f.name`).all().map(row=>({feed:String(row.feed),subscribed:Boolean(row.subscribed),posts:Number(row.posts)}));}
  cleanupIds(criteria:CleanupCriteria):string[]{
    const clauses=['1'],params:(string|number)[]=[];
    if(criteria.feed){clauses.push('p.subreddit=?');params.push(criteria.feed);}
    if(criteria.beforeMs!==null){clauses.push('p.created_ms<?');params.push(criteria.beforeMs);}
    if(criteria.readOnly)clauses.push('EXISTS(SELECT 1 FROM read_states WHERE post_id=p.id)');
    if(criteria.kind){
      const kinds=criteria.kind==='Media'?['Image','Video']:[criteria.kind];
      clauses.push(`coalesce(p.live_availability,o.availability)='available' AND (`+kinds.map(kind=>{
        params.push(kind,kind==='Image'?'image':kind==='Video'?'video':'');
        return `(EXISTS(SELECT 1 FROM json_each(${POST_MEDIA}) WHERE value=?) OR has_media_reference(${POST_OUTBOUND},coalesce((SELECT attachments FROM media_evidence WHERE post_id=p.id),${POST_ATTACHMENTS}),?))`;
      }).join(' OR ')+')');
    }
    return this.db.prepare(`SELECT p.id FROM posts p JOIN observations o ON o.rowid=(SELECT rowid FROM observations WHERE post_id=p.id ORDER BY (source='live') DESC,observed_at DESC,source_key DESC LIMIT 1) ${ARCHIVE_JOIN} WHERE ${clauses.join(' AND ')} ORDER BY p.created_ms DESC,p.id DESC`).all(...params).map(row=>String(row.id));
  }
  private syncMediaOwnership(id:string) {
    this.db.prepare('DELETE FROM post_media WHERE post_id=?').run(id);
    const insert=this.db.prepare('INSERT OR IGNORE INTO post_media VALUES (?,?)');
    for(const ref of this.getPost(id)?.attachments??[])insert.run(mediaKey(ref),id);
  }
  isPostExcluded(input:string):boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM excluded_posts WHERE post_id=?').get(postId(input)));
  }
  deletePost(input:string):string[] {
    return this.deletePosts([input]);
  }
  deletePosts(inputs:string[]):string[] {
    this.compactionWarning=null;
    const ids=[...new Set(inputs.map(postId))];if(!ids.length)return[];
    const keys=this.transaction(()=>{
      const owned=new Set<string>();
      for(const id of ids){
      const post=this.getPost(id);
      if(!post){if(this.isPostExcluded(id))continue;throw new Error('Post not found');}
      // Keep only identity and deletion time as the user's persistent exclusion preference.
      this.db.prepare('INSERT OR IGNORE INTO excluded_posts VALUES (?,?,?)').run(id,post.subreddit,Date.now());
      this.db.prepare('DELETE FROM comment_states WHERE post_id=?').run(id);
      for(const row of this.db.prepare('SELECT key FROM post_media WHERE post_id=?').all(id))owned.add(String(row.key));
      this.db.prepare('DELETE FROM posts WHERE id=?').run(id);
      }
      const released=[...owned].filter(key=>!this.hasMediaOwner(key));
      this.db.exec("UPDATE metadata SET value=value+1 WHERE key IN ('content_revision','media_sync_revision')");
      return released;
    });
    this.compactContent();return keys;
  }
  clearSubreddit(input:string):void {
    const name=subredditName(input);this.requireSubreddit(name);
    this.transaction(()=>{
      this.setSetting('sourceRevision:'+name,this.sourceRevision(name)+1);
      this.db.prepare("DELETE FROM settings WHERE key GLOB 'fileImport:*' AND json_extract(value,'$.subreddit')=?").run(name);
      this.db.prepare('DELETE FROM archive_fetches WHERE subreddit=?').run(name);
      this.db.prepare('DELETE FROM feed_sync WHERE subreddit=?').run(name);
      this.db.prepare('DELETE FROM comment_states WHERE post_id IN (SELECT id FROM posts WHERE subreddit=?)').run(name);
      this.db.prepare('UPDATE feeds SET history_target_id=NULL,requested_ms=NULL WHERE name=?').run(name);
      this.db.prepare('DELETE FROM targets WHERE subreddit=?').run(name);
      this.db.prepare('DELETE FROM posts WHERE subreddit=?').run(name);
      this.setSetting('imports',(this.getSetting<{subreddit?:string}[]>('imports')??[]).filter(item=>item.subreddit!==name));
      this.db.exec("UPDATE metadata SET value=value+1 WHERE key IN ('content_revision','media_sync_revision')");
    });
    this.compactContent();
  }
  compactStorage(){this.compactContent('Content kept');}
  private compactContent(message='Content cleared') {
    // Compaction is best effort; logical Clear and file cleanup must still finish.
    this.compactionWarning = null;
    try {
      const empty=!this.db.prepare('SELECT 1 FROM search_text LIMIT 1').get();
      this.db.exec(`INSERT INTO search_index(search_index) VALUES ('${empty?'rebuild':'optimize'}'); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);`);
    }
    catch { this.compactionWarning = message+'. Database compaction failed; some allocated space may remain in use.'; }
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.value)) as T : null;
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
  setSettings(values:Record<string,unknown>):void {this.transaction(()=>{for(const [key,value]of Object.entries(values))this.setSetting(key,value);});}
  bindAccount(account: string): void {
    if (!/^[a-z0-9_-]{3,24}$/i.test(account)) throw new Error('Invalid account identity');
    const current = this.getSetting<string>('account');
    if (current && current.toLowerCase() !== account.toLowerCase()) throw new Error('Account changed. Collection stopped to avoid merging accounts.');
    if (!current) this.setSetting('account', account);
  }
  addSource(input: { name: string; lowerMs?: number; historyMonths?: HistoryMonths }, upperMs = Date.now()): string {
    return this.transaction(()=>{
      const name=this.addSubreddit(input.name),months=historyMonths(input.historyMonths??1);
      const lowerMs=input.lowerMs??historyLowerBound(months,upperMs)??undefined;
      const id=this.createTarget({subreddit:name,lowerMs,upperMs});
      this.db.prepare('UPDATE feeds SET requested_ms=?,history_months=?,history_target_id=? WHERE name=?').run(upperMs,months,id,name);
      return id;
    });
  }
  pauseTarget(id: string, reason: string): void { this.db.prepare("UPDATE targets SET status = 'paused', reason = ? WHERE id = ? AND status NOT IN ('done','cancelled')").run(reason, id); }
  listTargets(): HistoryTarget[] { return this.db.prepare('SELECT id FROM targets ORDER BY rowid DESC LIMIT 100').all().map(row => this.getTarget(String(row.id))!); }
  removeSubreddit(input: string): void {
    const name = subredditName(input);
    this.transaction(() => {
      this.db.prepare("UPDATE targets SET status = 'cancelled', reason = 'Subreddit removed' WHERE subreddit = ? AND status IN ('paused','queued')").run(name);
      this.db.prepare('UPDATE feeds SET subscribed=0 WHERE name=?').run(name);
    });
  }
  followedSources(): string[] {return this.db.prepare('SELECT name FROM feeds WHERE subscribed=1 ORDER BY name').all().map(row=>String(row.name));}
  refollow(input:string):void {this.db.prepare('UPDATE feeds SET subscribed=1 WHERE name=?').run(subredditName(input));}

  feedSources(): FeedSource[] {
    return this.db.prepare(`SELECT s.name,s.history_months,s.history_target_id,
      (SELECT min(created_ms) FROM posts p WHERE p.subreddit = s.name AND EXISTS(SELECT 1 FROM observations WHERE post_id = p.id)) AS oldest_ms,
      (SELECT max(created_ms) FROM posts p WHERE p.subreddit = s.name AND EXISTS(SELECT 1 FROM observations WHERE post_id = p.id)) AS newest_ms,
      (SELECT count(*) FROM posts p WHERE p.subreddit = s.name AND EXISTS(SELECT 1 FROM observations WHERE post_id = p.id AND source = 'live')) AS live_count,
      (SELECT count(*) FROM posts p WHERE p.subreddit = s.name AND EXISTS(SELECT 1 FROM observations o WHERE o.post_id = p.id)) AS post_count
      FROM feeds s WHERE s.subscribed=1 ORDER BY s.name`).all()
      .map(row => ({ name: String(row.name),text:this.offlineText(String(row.name)), postCount: Number(row.post_count), historyMonths: historyMonths(Number(row.history_months)),
        historyTarget: row.history_target_id ? this.getTarget(String(row.history_target_id)) : null, oldestMs: row.oldest_ms as number | null, newestMs: row.newest_ms as number | null,
        liveCount: Number(row.live_count), archiveCount: Number(row.post_count)-Number(row.live_count),sync:this.feedSync(String(row.name)) }));
  }
  planSync(names:string[],now=Date.now()):{heads:string[];history:string[]} {
    return this.transaction(()=>{
      const heads:string[]=[],history:string[]=[];
      for(const input of names){
        const name=subredditName(input),pref=this.getHistoryPreference(name);
        let goal=pref.targetId?this.getTarget(pref.targetId):null;
        if(!goal||goal.status==='cancelled')goal=this.getTarget(this.createHistoryGoal(name,pref.months,now));
        const currentCutoff=historyLowerBound(pref.months,now);
        if(goal&&currentCutoff!==null&&goal.anchorMs<currentCutoff){
          this.pauseTarget(goal.id,'A newer rolling history window was requested; old checkpoint retained');
          goal=this.getTarget(this.createHistoryGoal(name,pref.months,now,false,true));
        }
        if(goal&&goal.status!=='done'&&!goal.continuation){
          heads.push(goal.id);
          this.db.prepare('UPDATE feeds SET requested_ms=? WHERE name=?').run(now,name);
        } else {
          const previous=this.db.prepare('SELECT requested_ms FROM feeds WHERE name = ?').get(name);
          const cutoff=historyLowerBound(pref.months,now);
          const lower=Math.max(Math.min(Number(previous?.requested_ms??now),goal?.anchorMs??now),cutoff??0);
          const fresh=this.createTarget({subreddit:name,lowerMs:Math.min(lower,now),upperMs:now});heads.push(fresh);
          if(goal&&goal.status!=='done')this.db.prepare('UPDATE targets SET depends_on = ? WHERE id = ?').run(fresh,goal.id);
          this.db.prepare('UPDATE feeds SET requested_ms=? WHERE name=?').run(now,name);
          if(goal&&goal.status!=='done')history.push(goal.id);
        }
      }
      return {heads,history};
    });
  }
  getHistoryPreference(input: string): {months: HistoryMonths; targetId: string | null} {
    const name=subredditName(input);this.requireSubreddit(name);
    const row=this.db.prepare('SELECT history_months,history_target_id FROM feeds WHERE name = ?').get(name);
    return {months:historyMonths(Number(row!.history_months)),targetId:row!.history_target_id as string | null};
  }
  /** Resuming uses only committed listing links, never the date of an imported post. */
  private createHistoryGoal(name: string, months: HistoryMonths, now: number, paused = false, fromHead = false): string {
    const lower=historyLowerBound(months,now);
    const selected=this.getHistoryPreference(name).targetId;
    const preferred=selected?this.getTarget(selected):null;
    const candidate=this.db.prepare(`SELECT id FROM targets WHERE subreddit = ? AND (continuation IS NOT NULL OR last_page IS NOT NULL)
      ORDER BY upper_ms DESC, (oldest_ms IS NULL), oldest_ms ASC, rowid DESC LIMIT 1`).get(name);
    const previous=fromHead?null:preferred&&(preferred.continuation||preferred.lastPage)?preferred:candidate?this.getTarget(String(candidate.id)):null;
    const id=this.createTarget({subreddit:name,lowerMs:lower ?? undefined,upperMs:now});
    // Expanding continues where prior committed browser work stopped. Unknown/stale
    // links are revalidated by the collector and can pause; dates never invent a cursor.
    this.db.prepare('UPDATE targets SET continuation = ?, status = ?, reason = ?, anchor_ms = ? WHERE id = ?').run(previous?.continuation ?? previous?.lastPage ?? null,
      paused?'paused':'queued',paused?'History limit reduced; collected posts retained. Resume to continue.':null,previous?.anchorMs??now,id);
    if(paused && previous?.status==='done' && ['date-boundary','prior-scan'].includes(previous.completion??'') && lower!==null && (previous.lowerMs===null||previous.lowerMs<=lower)) {
      this.db.prepare("UPDATE targets SET status = 'done', completion = 'prior-scan', reason = 'Previously scanned beyond this limit; collected posts retained' WHERE id = ?").run(id);
    }
    this.db.prepare('UPDATE feeds SET history_months = ?, history_target_id = ? WHERE name = ?').run(months,id,name);
    return id;
  }
  setHistoryLimit(input: string, value: unknown, now = Date.now()) {
    const name=subredditName(input),months=historyMonths(value),previous=this.getHistoryPreference(name);
    if(previous.months===months)return {changed:false,expanded:false,targetId:previous.targetId,headTargetId:null};
    return this.transaction(()=>{
      const expanded=historyRank(months)>historyRank(previous.months);
      if(previous.targetId)this.db.prepare("UPDATE targets SET status = 'cancelled', reason = 'History limit changed; checkpoint and content retained' WHERE id = ? AND status IN ('queued','paused')").run(previous.targetId);
      const targetId=this.createHistoryGoal(name,months,now,!expanded);
      const goal=this.getTarget(targetId)!;let headTargetId:string|null=null;
      if(expanded&&goal.continuation&&new URL(goal.continuation).search&&goal.anchorMs<now){
        headTargetId=this.createTarget({subreddit:name,lowerMs:Math.max(historyLowerBound(months,now)??0,Math.min(goal.anchorMs,now)),upperMs:now});
        this.db.prepare('UPDATE targets SET depends_on = ? WHERE id = ?').run(headTargetId,targetId);
      }
      return {changed:true,expanded,targetId,headTargetId};
    });
  }
  ensureHistoryTarget(input: string, now = Date.now()): string {
    const name=subredditName(input),pref=this.getHistoryPreference(name),target=pref.targetId?this.getTarget(pref.targetId):null;
    if(target&&target.status!=='cancelled')return target.id;
    return this.transaction(()=>this.createHistoryGoal(name,pref.months,now));
  }
  pauseSource(input: string, reason: string): void {
    const name = subredditName(input);
    this.transaction(() => {
      this.db.prepare("UPDATE targets SET status = 'paused', reason = ? WHERE subreddit = ? AND status IN ('queued','paused')").run(reason, name);
      this.db.prepare("UPDATE feed_sync SET state='incomplete',reason=? WHERE subreddit=? AND state='running'").run(reason,name);
    });
  }

  setRead(input:string,read:boolean):StoredPost {
    if(typeof read!=='boolean')throw new Error('Invalid read status');
    const id=postId(input);if(!this.getPost(id))throw new Error('Post is no longer stored');
    if(read)this.db.prepare('INSERT OR IGNORE INTO read_states VALUES (?,?)').run(id,Date.now());
    else this.db.prepare('DELETE FROM read_states WHERE post_id=?').run(id);
    return this.getPost(id)!;
  }
  favouriteUsers():Author[] {
    return this.db.prepare('SELECT platform,user_id AS id,display_name AS name FROM favourite_users ORDER BY display_name COLLATE NOCASE,platform,user_id').all().map(row=>authorIdentity(row));
  }
  favourites(){return {posts:Number(this.db.prepare('SELECT count(*) AS n FROM favourite_posts fp WHERE EXISTS(SELECT 1 FROM observations WHERE post_id=fp.post_id)').get()!.n),users:this.favouriteUsers()};}
  setPostFavourite(input:string,favourite:unknown):StoredPost {
    if(typeof favourite!=='boolean')throw new Error('Invalid favourite status');
    const id=postId(input);if(!this.getPost(id))throw new Error('Post is no longer stored');
    this.transaction(()=>{if(favourite)this.db.prepare('INSERT OR IGNORE INTO favourite_posts VALUES (?,?)').run(id,Date.now());else this.db.prepare('DELETE FROM favourite_posts WHERE post_id=?').run(id);this.db.exec("UPDATE metadata SET value=value+1 WHERE key='content_revision'");});
    return this.getPost(id)!;
  }
  setUserFavourite(input:unknown,favourite:unknown):void {
    const author=authorIdentity(input);if(typeof favourite!=='boolean')throw new Error('Invalid favourite status');
    this.transaction(()=>{
      if(favourite)this.db.prepare('INSERT INTO favourite_users VALUES (?,?,?,?) ON CONFLICT(platform,user_id) DO UPDATE SET display_name=excluded.display_name').run(author.platform,author.id,author.name,Date.now());
      else this.db.prepare('DELETE FROM favourite_users WHERE platform=? AND user_id=?').run(author.platform,author.id);
      this.db.exec("UPDATE metadata SET value=value+1 WHERE key='content_revision'");
    });
  }
  queryFeed(input: { subreddit?: string; media?: MediaFilter; text?: string; scope?:string; read?:string; readBefore?:number; favourites?:string;authorPlatform?:string;authorId?:string; afterMs?: number; beforeMs?: number; cursor?: string; limit?: number } = {}) {
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    if(input.favourites&&!['posts','users'].includes(input.favourites))throw new Error('Invalid favourites filter');
    const clauses: string[] = input.favourites?[]:["EXISTS(SELECT 1 FROM feeds f WHERE f.name=p.subreddit AND f.subscribed=1)"];
    const params: (string | number)[] = [];
    if(input.favourites==='posts')clauses.push('p.id IN (SELECT post_id FROM favourite_posts)');
    if(input.favourites==='users')clauses.push(`p.id IN (SELECT a.post_id FROM favourite_users fu JOIN observation_authors a ON json_extract(a.author,'$.platform')=fu.platform AND json_extract(a.author,'$.id')=fu.user_id)
      AND coalesce(p.live_availability,o.availability)<>'deleted' AND ${AUTHOR_FAVOURITE}`);
    if(input.authorPlatform!==undefined||input.authorId!==undefined){
      const author=authorIdentity({platform:input.authorPlatform,id:input.authorId,name:'Filter'});
      clauses.push(`coalesce(p.live_availability,o.availability)<>'deleted' AND json_extract(${POST_AUTHOR},'$.platform')=? AND json_extract(${POST_AUTHOR},'$.id')=?`);params.push(author.platform,author.id);
    }
    if (!Number.isInteger(limit)) throw new Error('Invalid feed limit');
    if(input.scope&&!['both','title','body'].includes(input.scope))throw new Error('Invalid search scope');
    if(input.text!==undefined&&(typeof input.text!=='string'||input.text.length>500))throw new Error('Search text must be at most 500 characters');
    if(input.read&&!['all','read','unread'].includes(input.read))throw new Error('Invalid read filter');
    const readBefore=input.readBefore??Date.now();if(!Number.isSafeInteger(readBefore)||readBefore<0)throw new Error('Invalid reading snapshot');
    if(input.read&&input.read!=='all'){
      clauses.push(`${input.read==='unread'?'NOT ':''}EXISTS(SELECT 1 FROM read_states r WHERE r.post_id=p.id AND r.read_at<=?)`);params.push(readBefore);
    }
    if (input.subreddit) { clauses.push('p.subreddit = ?'); params.push(subredditName(input.subreddit)); }
    for (const [value, operator] of [[input.afterMs, '>='], [input.beforeMs, '<']] as const) {
      if (value !== undefined) { if (!Number.isSafeInteger(value)) throw new Error('Invalid date filter'); clauses.push(`p.created_ms ${operator} ?`); params.push(value); }
    }
    if (input.cursor) {
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as { time: number; id: string };
      if (!Number.isSafeInteger(cursor.time) || postId(cursor.id) !== cursor.id) throw new Error('Invalid cursor');
      clauses.push('(p.created_ms < ? OR (p.created_ms = ? AND p.id < ?))'); params.push(cursor.time, cursor.time, cursor.id);
    }
    if (input.media) {
      const kinds=input.media==='Media'?['Image','Video']: [input.media];
      const matches=kinds.map(kind=>{
        params.push(kind,kind==='Image'?'image':kind==='Video'?'video':'');
        return `(EXISTS(SELECT 1 FROM json_each(${POST_MEDIA}) WHERE value = ?) OR has_media_reference(${POST_OUTBOUND},coalesce((SELECT attachments FROM media_evidence WHERE post_id=p.id),${POST_ATTACHMENTS}),?))`;
      });
      clauses.push(`coalesce(p.live_availability, o.availability) = 'available' AND (${matches.join(' OR ')})`);
    }
    if(input.text){
      const normalized=normalizeText(input.text);
      if(Array.from(normalized).length>=3&&!normalized.includes('\0')){
        const match=(input.scope==='title'?'title:':input.scope==='body'?'body:':'')+'"'+normalized.replaceAll('"','""')+'"';
        // Narrow rare matches without materializing an entire common-term hit
        // list. Broad matches use the literal scan and still include every post.
        const hits=this.db.prepare('SELECT rowid FROM search_index WHERE search_index MATCH ? LIMIT 501').all(match);
        if(hits.length<=500){
          clauses.push(hits.length?`p.id IN (SELECT post_id FROM search_text WHERE rowid IN (${hits.map(()=>'?').join(',')}))`:'0');
          params.push(...hits.map(row=>Number(row.rowid)));
        }
      }
      const body="CASE WHEN coalesce(p.live_availability,o.availability)='available' THEN st.body ELSE '' END";
      const fields=input.scope==='title'?['st.title']:input.scope==='body'?[body]:['st.title',body];
      clauses.push('('+fields.map(field=>{params.push(normalized);return `instr(${field},?)>0`;}).join(' OR ')+')');
    }
    const ids = this.db.prepare(`SELECT p.id FROM posts p JOIN observations o ON o.rowid =
      (SELECT rowid FROM observations WHERE post_id = p.id ORDER BY (source = 'live') DESC, observed_at DESC, source_key DESC LIMIT 1)
      ${ARCHIVE_JOIN}
      ${input.text?'JOIN search_text st ON st.post_id=p.id':''}
      ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY p.created_ms DESC, p.id DESC LIMIT ?`).all(...params, limit + 1);
    const result = ids.map(row => this.getPost(String(row.id))!);
    const hasMore = result.length > limit;
    const posts = result.slice(0, limit);
    const last = posts.at(-1);
    return { posts, next: hasMore && last ? feedCursor(last) : null };
  }
  stats() {
    return { posts: Number(this.db.prepare('SELECT count(*) AS n FROM posts WHERE EXISTS(SELECT 1 FROM observations WHERE post_id = posts.id)').get()!.n),
      snapshots: Number(this.db.prepare('SELECT count(*) AS n FROM thread_snapshots').get()!.n),
      mediaPosts: Number(this.db.prepare("SELECT count(DISTINCT post_id) AS n FROM (SELECT post_id FROM observations WHERE attachments IS NOT NULL AND attachments <> '[]' UNION SELECT post_id FROM media_evidence)").get()!.n),
      contentRevision: this.contentRevision,
      databaseBytes: this.databaseBytes() };
  }
  saveMediaReferences(generation: number, input: string, attachments: MediaReference[]) {
    return this.contentTransaction(()=>{
    if (generation !== this.generation) throw new StaleGenerationError();
    const post=this.getPost(input);
    if (!post || post.availability !== 'available' || !attachments.length) return;
    const validated=validateObservation({id:post.id,subreddit:post.subreddit,permalink:post.permalink,title:post.title,
      created:{epochMs:post.createdMs,precisionMs:post.precisionMs},source:'live',observedAt:Date.now(),attachments});
    // Media discovery is evidence about file URLs, not a new observation of the post's text.
    this.db.prepare(`INSERT INTO media_evidence VALUES (?,?,?) ON CONFLICT(post_id) DO UPDATE SET
      attachments=excluded.attachments,observed_at=excluded.observed_at`).run(post.id,JSON.stringify(validated.attachments),validated.observedAt);
    this.syncMediaOwnership(post.id);
    this.updateMediaSync(post.id);
    this.db.prepare("UPDATE metadata SET value = value + 1 WHERE key = 'content_revision'").run();
    });
  }
  markPostUnavailable(generation:number,input:string,availability:'removed'|'deleted',observedAt=Date.now()) {
    this.contentTransaction(()=>{
      if(generation!==this.generation)throw new StaleGenerationError();
      if(!['removed','deleted'].includes(availability))throw new Error('Expected explicit post removal evidence');
      const post=this.getPost(input);if(!post)return;
      this.writePost(validateObservation({id:post.id,subreddit:post.subreddit,title:post.title,permalink:post.permalink,
        created:{epochMs:post.createdMs,precisionMs:post.precisionMs},source:'live',observedAt,availability}));
      this.db.prepare("UPDATE metadata SET value=value+1 WHERE key='content_revision'").run();
    });
  }
  savePostBody(generation:number,input:string,body:string,observedAt=Date.now(),author?:Author|null) {
    this.contentTransaction(()=>{
      if(generation!==this.generation)throw new StaleGenerationError();
      const post=this.getPost(input);if(!post||post.availability!=='available')return;
      this.writePost(validateObservation({id:post.id,subreddit:post.subreddit,title:post.title,permalink:post.permalink,
        created:{epochMs:post.createdMs,precisionMs:post.precisionMs},source:'live',observedAt,body,author,
        media:post.media,outbound:post.outbound??undefined}));
    });
  }
  saveSnapshot(generation: number, snapshot: ThreadSnapshot): void {
    this.contentTransaction(() => {
      if (generation !== this.generation) throw new StaleGenerationError();
      const post = this.getPost(snapshot.postId);
      if (!post) throw new Error('Post was cleared or is unavailable');
      if (post.availability !== 'available' && snapshot.source === 'archive') throw new Error('Live deletion blocks restoring archive content');
      // An author alone cannot prove that a removed post was reinstated.
      if (snapshot.source === 'live' && (snapshot.body !== null || snapshot.availability !== 'available'||(snapshot.author!==undefined&&post.availability==='available'))) {
        // A discussion body alone does not establish that previously observed
        // media disappeared, including when this is the first live observation.
        this.writePost(validateObservation({ id: post.id, subreddit: post.subreddit, title: post.title, permalink: post.permalink,
          created: { epochMs: post.createdMs, precisionMs: post.precisionMs }, source: 'live', observedAt: snapshot.observedAt,
          body: snapshot.body ?? undefined, availability: snapshot.availability,author:snapshot.author,
          media:post.media,attachments:post.attachments,outbound:post.outbound??undefined }));
      }
      if (snapshot.source === 'live') {
        for (const comment of snapshot.comments) {
          this.db.prepare(`INSERT INTO comment_states VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET availability = excluded.availability, observed_at = excluded.observed_at WHERE excluded.observed_at >= comment_states.observed_at`)
            .run(comment.id, snapshot.postId, comment.availability, snapshot.observedAt);
          const state = this.db.prepare('SELECT availability FROM comment_states WHERE id = ?').get(comment.id)!;
          if (state.availability !== 'available') {
            const old = this.db.prepare('SELECT id, data FROM thread_snapshots WHERE post_id = ?').all(snapshot.postId);
            for (const row of old) {
              const saved = JSON.parse(String(row.data)) as ThreadSnapshot;
              saved.comments = saved.comments.map(item => item.id === comment.id ? { ...item, body: '', availability: state.availability as Availability } : item);
              this.db.prepare('UPDATE thread_snapshots SET data = ? WHERE id = ?').run(JSON.stringify(saved), String(row.id));
            }
          }
        }
      }
      const safe = { ...snapshot, comments: snapshot.comments.map(comment => {
        const state = this.db.prepare('SELECT availability FROM comment_states WHERE id = ?').get(comment.id);
        return state && state.availability !== 'available' ? { ...comment, body: '', availability: state.availability as Availability } : comment;
      }) };
      if(safe.source==='archive'&&safe.exportId){
        const signature=snapshotContent(safe);
        for(const row of this.db.prepare("SELECT id,data FROM thread_snapshots WHERE post_id=? AND source='archive' AND json_extract(data,'$.exportId')=?").iterate(safe.postId,safe.exportId)){
          if(snapshotContent(JSON.parse(String(row.data)))!==signature)continue;
          const reused={...safe,id:String(row.id)};
          this.db.prepare('UPDATE thread_snapshots SET observed_at=?,data=? WHERE id=?').run(safe.observedAt,JSON.stringify(reused),String(row.id));return;
        }
      }
      this.db.prepare('INSERT INTO thread_snapshots VALUES (?, ?, ?, ?, ?)').run(snapshot.id, snapshot.postId, snapshot.observedAt, snapshot.source, JSON.stringify(safe));
    });
  }
  latestSnapshot(input: string): ThreadSnapshot | null {
    const post = this.getPost(input); if (!post) return null;
    const row = this.db.prepare("SELECT data FROM thread_snapshots WHERE post_id = ? ORDER BY (source = 'live') DESC, observed_at DESC LIMIT 1").get(post.id);
    if (!row) return null;
    const snapshot = JSON.parse(String(row.data)) as ThreadSnapshot;
    const comments = snapshot.comments.map(comment => {
      const state = this.db.prepare('SELECT availability FROM comment_states WHERE id = ?').get(comment.id);
      return state && state.availability !== 'available' ? { ...comment, body: '', availability: state.availability as Availability } : comment;
    });
    return { ...snapshot, comments, body: post.availability === 'available' ? snapshot.body : null, availability: post.availability };
  }
  private writeObservation(record: PostObservation): void {
    const key = record.source === 'live' ? 'live' : `archive:${record.exportId}`;
    const previous = this.db.prepare('SELECT availability,observed_at FROM observations WHERE post_id = ? AND source_key = ?').get(record.id, key);
    const tombstone = this.db.prepare('SELECT live_availability FROM posts WHERE id = ?').get(record.id);
    // Missing body/availability in a head card is not evidence that a removed body was restored.
    const availability = record.availability ?? (previous?.availability as Availability | undefined)
      ?? (record.source === 'live' ? tombstone?.live_availability as Availability | undefined : undefined) ?? 'available';
    const retainBody = availability === 'available' && !(record.source === 'archive' && tombstone?.live_availability && tombstone.live_availability !== 'available');
    this.db.prepare(`INSERT INTO observations
      (post_id, source_key, source, export_id, title, body, media, availability, observed_at, captured_at, attachments, outbound)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (post_id, source_key) DO UPDATE SET
        title = excluded.title,
        body = CASE WHEN excluded.availability <> 'available' THEN NULL ELSE coalesce(excluded.body, observations.body) END,
        media = CASE WHEN excluded.availability <> 'available' THEN '[]' ELSE coalesce(excluded.media,
          CASE WHEN excluded.outbound IS NULL OR excluded.outbound=observations.outbound THEN observations.media END) END,
        attachments = CASE WHEN excluded.availability <> 'available' THEN '[]' ELSE coalesce(excluded.attachments,
          CASE WHEN excluded.outbound IS NULL OR excluded.outbound=observations.outbound THEN observations.attachments END) END,
        outbound = CASE WHEN excluded.availability <> 'available' THEN NULL ELSE coalesce(excluded.outbound, observations.outbound) END,
        availability = excluded.availability, observed_at = excluded.observed_at,
        captured_at = coalesce(excluded.captured_at, observations.captured_at)
      WHERE excluded.observed_at >= observations.observed_at`)
      .run(record.id, key, record.source, record.exportId ?? null, record.title,
        retainBody ? record.body ?? null : null,
        retainBody ? record.media ? JSON.stringify(record.media) : null : '[]',
        availability, record.observedAt, record.capturedAt ?? null, retainBody ? record.attachments?.length ? JSON.stringify(record.attachments) : null : '[]',retainBody?record.outbound??null:null);
    if((record.author!==undefined||availability==='deleted')&&(!previous||record.observedAt>=Number(previous.observed_at))){
      this.db.prepare('INSERT INTO observation_authors VALUES (?,?,?) ON CONFLICT(post_id,source_key) DO UPDATE SET author=excluded.author').run(record.id,key,JSON.stringify(availability==='deleted'?null:record.author));
    }
    if (record.source === 'live') {
      const live = this.db.prepare("SELECT availability, observed_at FROM observations WHERE post_id = ? AND source_key = 'live'").get(record.id)!;
      this.db.prepare('UPDATE posts SET live_availability = ?, live_state_at = ? WHERE id = ?')
        .run(live.availability!, live.observed_at!, record.id);
      if (live.availability !== 'available') {
        this.db.prepare("UPDATE observations SET body = NULL, media = '[]', attachments = '[]', outbound=NULL WHERE post_id = ?").run(record.id);
        // Retain surviving discussion comments while redacting the removed post body.
        this.db.prepare("UPDATE thread_snapshots SET data = json_set(data, '$.body', NULL, '$.availability', ?) WHERE post_id = ?").run(live.availability!, record.id);
      }
    }
  }

  private writePost(record: PostObservation): number {
    this.requireSubreddit(record.subreddit);
    if(this.isPostExcluded(record.id))return 0;
    const existing = this.db.prepare('SELECT subreddit, live_state_at FROM posts WHERE id = ?').get(record.id);
    if (existing && existing.subreddit !== record.subreddit) throw new Error('Conflicting post identity');
    const insert = this.db.prepare(`INSERT OR IGNORE INTO posts
      (id, subreddit, permalink, created_ms, precision_ms) VALUES (?, ?, ?, ?, ?)`)
      .run(record.id, record.subreddit, record.permalink, record.created.epochMs, record.created.precisionMs);
    if (record.source === 'live' && existing?.live_state_at !== null && existing?.live_state_at !== undefined &&
        record.observedAt < Number(existing.live_state_at)) return Number(insert.changes);
    const changedMediaLink=record.source==='live'&&record.outbound!==undefined&&Boolean(existing)&&this.getPost(record.id)?.outbound!==record.outbound;
    // A delayed live result cannot replace the creation metadata of a newer observation.
    if (record.source === 'live') {
      this.db.prepare('UPDATE posts SET created_ms = ?, precision_ms = ? WHERE id = ?')
        .run(record.created.epochMs, record.created.precisionMs, record.id);
    }
    this.writeObservation(record);
    if(record.source==='live' && ((record.availability && record.availability!=='available') || record.attachments?.length || changedMediaLink))
      this.db.prepare('DELETE FROM media_evidence WHERE post_id=?').run(record.id);
    this.syncMediaOwnership(record.id);
    this.updateMediaSync(record.id);
    const preferred=this.getPost(record.id)!;
    if(preferred.availability==='available'&&preferred.media.includes('Text')){
      const status=record.bodyNeedsFetch||preferred.body===null?'pending':'ready';
      this.db.prepare(`INSERT INTO body_sync(post_id,status) VALUES (?,?) ON CONFLICT(post_id) DO UPDATE SET status=excluded.status,reason=NULL
        WHERE ? OR (? AND ?='live')`).run(record.id,status,Number(Boolean(record.bodyNeedsFetch)),Number(record.body!==undefined),record.source);
    }else this.db.prepare('DELETE FROM body_sync WHERE post_id=?').run(record.id);
    this.db.prepare(`INSERT INTO search_text(post_id,title,body) VALUES (?,?,?) ON CONFLICT(post_id) DO UPDATE SET title=excluded.title,body=excluded.body WHERE title<>excluded.title OR body<>excluded.body`)
      .run(record.id,normalizeText(preferred.title),normalizeText(preferred.body??''));
    this.db.prepare("UPDATE metadata SET value=value+1 WHERE key='content_revision'").run();
    return Number(insert.changes);
  }

  private updateMediaSync(id:string) {
    const preferred=this.getPost(id)!;
    if(preferred.availability==='available'&&preferred.media.some(kind=>kind==='Image'||kind==='Video')){
      this.db.prepare(`INSERT INTO media_sync(post_id,signature) VALUES (?,?) ON CONFLICT(post_id) DO UPDATE SET
        status='pending',reason=NULL,session=NULL,signature=excluded.signature WHERE media_sync.signature<>excluded.signature`)
        .run(preferred.id,createHash('sha256').update(JSON.stringify(preferred.attachments)+'\n'+(preferred.outbound??'')).digest('hex'));
    }else this.db.prepare('DELETE FROM media_sync WHERE post_id=?').run(id);
  }

  private requireSubreddit(name: string): void {
    if (!this.db.prepare('SELECT name FROM feeds WHERE name = ?').get(name)) {
      throw new Error(`Add r/${name} before storing its content or history target`);
    }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private contentTransaction<T>(action:()=>T):T {
    return this.transaction(()=>{
      this.assertStorageAvailable();
      const result=action();
      this.assertStorageFits();
      return result;
    });
  }
}
