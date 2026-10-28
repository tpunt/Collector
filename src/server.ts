import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { extname, resolve, sep, join, dirname } from 'node:path';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReaderStore } from './store.ts';
import { databasePath, dataDirectory } from './paths.ts';
import { ReaderJobs } from './jobs.ts';
import type { JobDependencies } from './jobs.ts';
import { ArchiveImporter } from './archive.ts';
import { ArchiveFetcher } from './archive-fetch.ts';
import { historyMonths, historyLowerBound, historyRank } from './history-window.ts';
import { MEDIA_FILTERS, postId, subredditName } from './domain.ts';
import type { MediaFilter } from './domain.ts';
import {feedName,feedIdentity,tumblrBlog} from './sources.ts';
import { MediaCache } from './media.ts';
import type { MediaDependencies } from './media.ts';
import { RequestQueue } from './request-gate.ts';
import { STORAGE_CAP_MESSAGE } from './storage-limit.ts';
import {LibraryBackups,recoverLibraryRestore} from './library-backup.ts';
import {cleanupCriteria,cleanupPreview,storageBreakdown} from './library-storage.ts';
import type {CleanupCriteria} from './library-storage.ts';
import {claimInstance} from './instance.ts';
import {NetworkMode} from './network-mode.ts';
import {onlinePlayer} from './online-player.ts';
import {WebSocketServer} from 'ws';
import {ProblemLog} from './problems.ts';
import {CollectionReports} from './collection-report.ts';

export function createReaderServer(options: { database?: string; port?: number; root?:string; onShutdown?:()=>Promise<void>; backup?:{workFactor?:number}; archive?:{fetch?:typeof fetch}; jobs?: JobDependencies; media?: Partial<Pick<MediaDependencies,'directory'|'fetch'|'maxBytes'|'maxRequests'>> } = {}) {
  const database=options.database??databasePath;
  const lease=claimInstance(database,options.root??resolve(import.meta.dirname,'..'));
  let startupStore:ReaderStore|undefined;
  try {
  const temporaryMedia=database===':memory:'&&!options.media?.directory;
  const mediaDirectory=options.media?.directory??(temporaryMedia?join(tmpdir(),'reddit-reader-media-'+randomBytes(12).toString('hex')):options.database?join(dirname(resolve(database)),'media'):join(dataDirectory,'media'));
  const backupDirectory=database===':memory:'?join(tmpdir(),'collector-backups-'+randomBytes(12).toString('hex')):join(dirname(database),'.backup-work');
  recoverLibraryRestore(database,mediaDirectory,backupDirectory);
  const store = startupStore = new ReaderStore(database);
  const problems=new ProblemLog(database===':memory:'?join(mediaDirectory,'.problems'):join(dirname(resolve(database)),'logs'));
  const network = options.jobs?.network ?? new RequestQueue({fromCompletion:true});
  let media: MediaCache;
  let archive:ArchiveFetcher;
  const reports=new CollectionReports(store);
  const jobs = new ReaderJobs(store, {...options.jobs,reports,problems:(context,error)=>{problems.report(context,error);options.jobs?.problems?.(context,error);},network,onPause:()=>{media?.stop();archive?.pause(store.getSetting<{reason:string}>('accessPause')?.reason??'Collection stopped; Resume archive to continue');options.jobs?.onPause?.();}});
  media = new MediaCache(store,{...options.media,directory:mediaDirectory,queue:network,onSaved:(feed,bytes)=>reports.saved(feed,bytes),onAccess:error=>jobs.accessFailure(error)});
  jobs.attachMedia(options.jobs?.mediaSync===undefined?media:options.jobs.mediaSync);
  const importer = new ArchiveImporter(store,problems.report);
  const backups=new LibraryBackups(store,media,backupDirectory,mediaDirectory,options.backup?.workFactor);
  archive=new ArchiveFetcher(store,{...options.archive,reports,problems:problems.report,queue:network,assertCanStart:resume=>{
    if(importer.progress?.state==='running')throw new Error('Stop the file import before fetching an archive');
    jobs.assertCanQueue(resume);
  },onRunStart:()=>jobs.beginArchiveRun(),saveMedia:(ids,signal)=>jobs.archiveMedia(ids,signal)});
  const networkMode=new NetworkMode(store,network,jobs,archive,media);
  const feedStatus=(name:string)=>archive.active?.subreddit===name&&archive.active.state==='running'?'syncing' as const:jobs.feedStatus(name)==='idle'?media.feedStatus(name):jobs.feedStatus(name);
  const token = randomBytes(32).toString('hex');
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  let origin = '';
  let cleaningContent=false;
  let replacement:Promise<void>|null=null;
  const readIntents=new Map<string,number>();
  const cleanupPlans=new Map<string,{ids:string[];criteria:CleanupCriteria;revision:number;mediaRevision:number;expires:number}>();
  const cleanupPaths=new Set(['/api/remove','/api/clear-source','/api/delete-post','/api/clear','/api/backup/create','/api/restore/commit','/api/storage/preview','/api/storage/delete','/api/storage/compact']);
  const stopPaths=new Set(['/api/pause','/api/import/stop','/api/archive/stop','/api/sign-in/finish','/api/offline']);
  const assertCleanupIdle=(path:string)=>{if(cleaningContent&&!stopPaths.has(path))throw new Error('Content cleanup is still in progress. Try again when it finishes.');};
  const quiesce=async(reason:string)=>{await archive.close(reason);await importer.close();await jobs.close(reason);await media.close();};
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); };
  const body = async (req: IncomingMessage) => {
    let content = ''; for await (const chunk of req) { content += chunk; if (content.length > 32_000) throw new Error('Request too large'); }
    const value=JSON.parse(content||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected a JSON object');return value as Record<string,unknown>;
  };
  const date = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const result = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid date');
    return result;
  };
  const feedQuery=(params:URLSearchParams)=>{
    const media=params.get('media')??undefined;
    if(media&&!MEDIA_FILTERS.includes(media as MediaFilter))throw new Error('Invalid media filter');
    return {tag:params.get('tag')||undefined,subreddit:params.get('subreddit')||undefined,media:media as MediaFilter|undefined,
      favourites:params.get('favourites')||undefined,authorPlatform:params.get('authorPlatform')??undefined,authorId:params.get('authorId')??undefined,
      read:params.get('read')??undefined,readBefore:params.has('readBefore')?Number(params.get('readBefore')):undefined,
      text:params.get('q')??'',scope:params.get('scope')??undefined,afterMs:date(params.get('after')),beforeMs:date(params.get('before')),
      cursor:params.get('cursor')||undefined};
  };
  let closing:Promise<void>|null=null,stopping=false,shutdownRequested=false;
  const requests=new Set<Promise<void>>();
  const handle = async (req:IncomingMessage, res:ServerResponse) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${origin.replace(/^http:/,'ws:')}; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, { error: 'Local requests only' },403); return; }
      const url = new URL(req.url ?? '/', origin);
      if(stopping)throw new Error('Collector is stopping');
      if(url.pathname==='/api/instance'&&req.method==='GET'){json(res,lease?.record??{id:null});return;}
      if(req.method==='GET'&&replacement)await replacement;
      if(backups.recoveryRequired&&url.pathname!=='/api/shutdown')throw new Error('Restore recovery requires an application restart; library access is blocked until recovery');
      if (req.method === 'POST') {
        const supplied = String(req.headers['x-reader-token'] ?? '');
        if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { json(res,{error:'Invalid local request token'},403); return; }
        assertCleanupIdle(url.pathname);
        if(url.pathname==='/api/restore/prepare'){
          cleaningContent=true;const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
          try{json(res,await backups.prepare(req,decodeURIComponent(String(req.headers['x-backup-passphrase']??'')),controller.signal));}
          finally{res.removeListener('close',cancel);cleaningContent=false;}
          return;
        }
        if (url.pathname === '/api/import') {
          if(archive.running)throw new Error('Stop the archive fetch before importing a file');
          const ids = (url.searchParams.get('postIds') ?? '').split(',').filter(Boolean).map(postId);
          const result = await importer.run(req, { subreddit: url.searchParams.get('subreddit') ?? '', filename: url.searchParams.get('filename') ?? '',
            size: Number(url.searchParams.get('size')), modified: Number(url.searchParams.get('modified')),
            afterMs: date(url.searchParams.get('after')), beforeMs: date(url.searchParams.get('before')), postIds: ids });
          await media.reconcile();
          if(result.reason?.includes('Storage cap'))jobs.pause(STORAGE_CAP_MESSAGE);
          json(res,result); return;
        }
        const data = await body(req);
        // Recheck after reading the body: another request may have begun cleanup meanwhile.
        assertCleanupIdle(url.pathname);
        if(stopping)throw new Error('Collector is stopping');
        const cleansContent=cleanupPaths.has(url.pathname);
        if(cleansContent)cleaningContent=true;
        try {
        switch (url.pathname) {
          case '/api/problems/acknowledge': problems.acknowledge(data.records as {id:string;count:number}[]);json(res,problems.list());return;
          case '/api/offline': {
            if(typeof data.offline!=='boolean')throw new Error('Choose Offline mode on or off');
            if(!data.offline&&cleaningContent)throw new Error('Wait for local maintenance before resuming online work');
            json(res,{network:await networkMode.change(data.offline)});return;
          }
          case '/api/shutdown': {
            if(!options.onShutdown)throw new Error('Stop this app from its terminal');
            if(!shutdownRequested){shutdownRequested=true;res.once('finish',()=>setImmediate(()=>void options.onShutdown!().catch(error=>console.error('Unable to stop Collector:',error.message))));}
            json(res,{ok:true});return;
          }
          case '/api/storage/preview': {
            const criteria=cleanupCriteria(data);if(criteria.feed&&!store.storageFeeds().some(feed=>feed.feed===criteria.feed))throw new Error('Choose a stored feed');
            await quiesce('Paused for cleanup preview; Resume to continue');const inventory=await media.inventory();
            const {ids,...preview}=cleanupPreview(store,inventory,criteria),id=randomUUID();cleanupPlans.clear();
            cleanupPlans.set(id,{ids,criteria,revision:store.contentRevision,mediaRevision:media.status.revision,expires:Date.now()+10*60_000});
            json(res,{...preview,id});return;
          }
          case '/api/storage/discard': cleanupPlans.delete(String(data.id));json(res,{ok:true});return;
          case '/api/storage/compact': await quiesce('Paused to reclaim storage; Resume to continue');await media.reconcile();store.compactStorage();json(res,{warning:store.compactionWarning});return;
          case '/api/storage/delete': {
            if(data.confirm!==true)throw new Error('Confirm deleting the previewed posts first');
            const id=String(data.id),plan=cleanupPlans.get(id);
            if(!plan||plan.expires<Date.now())throw new Error('Cleanup preview expired; preview again');
            await quiesce('Paused for storage cleanup; Resume to continue');await media.inventory();
            if(plan.revision!==store.contentRevision||plan.mediaRevision!==media.status.revision||JSON.stringify(plan.ids)!==JSON.stringify(store.cleanupIds(plan.criteria)))throw new Error('The library changed; preview cleanup again');
            cleanupPlans.delete(id);const keys=store.deletePosts(plan.ids);let warning=store.compactionWarning;
            try{await media.clearPosts(plan.ids,keys);}catch{warning=[warning,'Posts deleted, but some files could not be removed. Restart to retry file cleanup.'].filter(Boolean).join(' ');}
            json(res,{deleted:plan.ids.length,warning,storage:store.storage});return;
          }
          case '/api/backup/create': {
            const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);
            try{await quiesce('Paused to create a backup; Resume to continue');json(res,await backups.create(data.passphrase,controller.signal));}
            finally{res.removeListener('close',cancel);}return;
          }
          case '/api/restore/commit': {
            if(data.confirm!==true)throw new Error('Confirm library replacement first');await quiesce('Paused to restore a backup; Resume to continue');replacement=backups.restore(String(data.id));
            try{await replacement;networkMode.cancel();await importer.clear();cleanupPlans.clear();json(res,{ok:true,warning:store.compactionWarning});}finally{replacement=null;}return;
          }
          case '/api/restore/discard': await backups.discard(String(data.id));json(res,{ok:true});return;
          case '/api/read': {
            const id=postId(String(data.id)),post=store.getPost(id);
            if(data.context!==undefined&&data.context!==post?.readContext)throw new Error('Post changed while reading; refresh the view and try again');
            let key:string|undefined;
            if(data.client!==undefined||data.sequence!==undefined){
              if(typeof data.client!=='string'||!/^[a-f0-9-]{36}$/i.test(data.client)||!Number.isSafeInteger(data.sequence)||Number(data.sequence)<1)throw new Error('Invalid read intent');
              key=data.client+':'+id;
              if((readIntents.get(key)??0)>=Number(data.sequence)){json(res,{post});return;}
            }
            const updated=store.setRead(id,data.read as boolean);
            if(key){readIntents.delete(key);readIntents.set(key,Number(data.sequence));if(readIntents.size>100_000)readIntents.delete(readIntents.keys().next().value!);}
            json(res,{post:updated});return;
          }
          case '/api/tags': {
            const post=store.getPost(postId(String(data.id)));
            if(!post||data.context!==post.readContext)throw new Error('Post changed; refresh the view and try again');
            json(res,{post:store.setPostTags(post.id,data.tags)});return;
          }
          case '/api/read/bulk': {
            if(data.confirm!==true||typeof data.query!=='string'||data.query.length>12000)throw new Error('Confirm marking matching posts read');
            if(data.revision!==store.contentRevision)throw new Error('The library changed; review the filters and try again');
            const query=feedQuery(new URLSearchParams(data.query));delete query.cursor;
            json(res,{changed:store.markFeedRead(query,Number(data.generation))});return;
          }
          case '/api/favourite/post': {
            const post=store.getPost(postId(String(data.id)));
            if(!post||data.context!==post.readContext)throw new Error('Post changed; refresh the view and try again');
            json(res,{post:store.setPostFavourite(post.id,data.favourite)});return;
          }
          case '/api/favourite/user': {
            store.setUserFavourite(data.author,data.favourite);json(res,{favourites:store.favourites()});return;
          }
          case '/api/settings': {
            store.setStorageLimit(data.maxStoredBytes);
            if(store.storage.full){jobs.pause(STORAGE_CAP_MESSAGE);importer.stop();}
            json(res,{storage:store.storage});return;
          }
          case '/api/sources': {
            if(data.platform!==undefined&&!['reddit','tumblr'].includes(String(data.platform)))throw new Error('Choose Reddit or Tumblr');
            const name = data.platform==='tumblr'?'tumblr:'+tumblrBlog(String(data.name??'')):data.platform==='reddit'?subredditName(String(data.name??'')):feedName(String(data.name ?? ''));
            if(store.followedSources().includes(name))throw new Error('This feed is already subscribed; change its history limit on Feeds');
            const months = historyMonths(data.historyMonths ?? 1);
            const now = Date.now(), lowerMs=historyLowerBound(months,now);
            jobs.assertCanQueue(true);
            if (jobs.feedStatus(name) !== 'idle') throw new Error('This feed is already syncing or queued');
            const id = store.addSource({name, lowerMs:lowerMs??undefined,historyMonths:months}, now); store.refollow(name);
            jobs.syncFeeds([name],{heads:[id],history:[]});
            json(res,{id}); return;
          }
          case '/api/archive/start': {
            const name=subredditName(String(data.subreddit??''));
            if(jobs.feedStatus(name)!=='idle'||media.feedStatus(name)!=='idle')throw new Error('Stop this feed’s sync before fetching an archive');
            json(res,{id:archive.start({subreddit:name,from:data.from,to:data.to})});return;
          }
          case '/api/archive/resume': {
            const job=store.archiveFetch(String(data.id));
            if(job&&(jobs.feedStatus(job.subreddit)!=='idle'||media.feedStatus(job.subreddit)!=='idle'))throw new Error('Stop this feed’s sync before resuming its archive');
            archive.resume(String(data.id));json(res,{ok:true});return;
          }
          case '/api/archive/stop': {
            const job=archive.active;
            const paused=typeof data.id==='string'&&networkMode.status.offline?store.archiveFetch(data.id):null;
            if(typeof data.id==='string'&&job?.id!==data.id&&!paused)throw new Error('This archive fetch is no longer active');
            if(job||paused)networkMode.cancel({source:(job??paused)!.subreddit});
            await archive.stop();if(job){media.stop(job.subreddit);await jobs.stopSource(job.subreddit,'Archive stopped by user');}
            if(job||paused)networkMode.cancel({source:(job??paused)!.subreddit});
            json(res,{ok:true});return;
          }
          case '/api/media/retry': {
            const names=Array.isArray(data.names)?[...new Set(data.names.map(name=>feedName(String(name))))]:[];
            if(names.some(name=>feedStatus(name)!=='idle'))throw new Error('Wait for this feed to finish before retrying downloads');
            jobs.retryMedia(names);json(res,{queued:true});return;
          }
          case '/api/sync': {
            jobs.assertCanQueue(true);
            const followed = store.followedSources();
            const selected = Array.isArray(data.names) && data.names.length ? [...new Set(data.names.map(item => feedName(String(item))))] : followed;
            if (selected.some(name => !followed.includes(name))) throw new Error('Sync requires a subscribed feed');
            if (!selected.length) throw new Error('Add a feed first');
            const names = selected.filter(name => feedStatus(name) === 'idle');
            json(res,{queued:jobs.syncFeeds(names)});return;
          }
          case '/api/history': {
            const name=feedName(String(data.name)),months=historyMonths(data.months);
            if(archive.active?.subreddit===name)throw new Error('Stop the archive fetch before changing this feed’s history');
            if(!store.followedSources().includes(name))throw new Error('Subscribe to this feed first');
            const previous=store.getHistoryPreference(name),changed=previous.months!==months;
            const expanded=historyRank(months)>historyRank(previous.months);
            const shouldFetch=expanded;
            if(shouldFetch)jobs.assertCanQueue(true);
            if(changed&&network.offline)networkMode.cancel({source:name});
            if(changed&&jobs.feedStatus(name)!=='idle')await jobs.stopSource(name,expanded?'History limit expanded':'History limit reduced; collected posts retained');
            const result=store.setHistoryLimit(name,months);
            const targetId=shouldFetch?store.ensureHistoryTarget(name):result.targetId;
            if(targetId&&shouldFetch)jobs.syncFeeds([name],{heads:result.headTargetId?[result.headTargetId]:[],history:[targetId]});
            json(res,{...result,targetId,queued:Boolean(targetId&&jobs.hasTarget(targetId))});return;
          }
          case '/api/pause': {
            const selection=typeof data.name==='string'?{source:feedName(data.name)}:{};
            networkMode.cancel(selection);
            if(selection.source){await archive.stop(selection.source);media.stop(selection.source);await jobs.stopSource(selection.source);}else{await archive.stop();jobs.pause();}
            networkMode.cancel(selection);break;
          }
          case '/api/sign-in': if(archive.running)throw new Error('Pause archive collection before signing in');await jobs.signIn(); break;
          case '/api/sign-in/finish': await jobs.finishSignIn(); break;
          case '/api/remove': {
            if (data.confirm !== true) throw new Error('Confirm feed removal first');
            const name = feedName(String(data.name));
            networkMode.cancel({source:name});
            await archive.stop(name,'Feed removed; stored archive progress kept');
            media.stop(name);
            await jobs.stopSource(name, 'Feed removed');await importer.stopSource(name);store.removeSubreddit(name);networkMode.cancel({source:name});break;
          }
          case '/api/clear-source': {
            if(data.confirm!==true)throw new Error('Confirm clearing subreddit data first');
            const name=feedName(String(data.name));
            if(!store.followedSources().includes(name))throw new Error('Choose a subscribed subreddit');
            networkMode.cancel({source:name});
            await archive.stop(name,'Archive data cleared');
            await jobs.stopSource(name,'Data cleared');await importer.clearSource(name);
            const keys=store.ownedMediaKeys(name);
            store.clearSubreddit(name);await media.clearSource(name,keys);networkMode.cancel({source:name});
            json(res,{ok:true,warning:store.compactionWarning});return;
          }
          case '/api/delete-post': {
            if(data.confirm!==true)throw new Error('Confirm deleting this post first');
            const id=postId(String(data.id));
            networkMode.cancel({post:id});
            media.stopPost(id);await jobs.stopPost(id);
            const keys=store.deletePost(id),warning=store.compactionWarning;
            await media.clearPost(id,keys);json(res,{ok:true,warning});return;
          }
          case '/api/thread': jobs.thread(postId(String(data.id))); break;
          case '/api/clear': networkMode.cancel();await archive.stop(undefined,'Archive data cleared');jobs.pause('Content cleared');await importer.clear();store.clearContent();await media.clear();store.setSetting('imports',[]);json(res,{ok:true,warning:store.compactionWarning});return;
          case '/api/import/stop': importer.stop(); break;
          default: json(res,{error:'Not found'},404); return;
        }
        json(res,{ok:true}); return;
        } finally {if(cleansContent)cleaningContent=false;}
      }
      if (req.method !== 'GET') { json(res,{error:'Method not allowed'},405); return; }
      if(url.pathname==='/api/problems'){json(res,problems.list());return;}
      if(url.pathname==='/api/problems/download'){const {path,...diagnostics}=problems.list();res.setHeader('Content-Disposition','attachment; filename="collector-problems.json"');json(res,diagnostics);return;}
      if(url.pathname==='/api/network/events'){json(res,{error:'WebSocket connection required'},426);return;}
      if(url.pathname==='/online-player'){network.assertOnline();const player=onlinePlayer(url.searchParams.get('url')??'',token,origin);res.setHeader('Content-Security-Policy',player.csp);res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(player.body);return;}
      if(url.pathname==='/api/storage'){json(res,storageBreakdown(store,await media.inventory()));return;}
      if(url.pathname.startsWith('/api/backup/download/')){
        const file=backups.download(url.pathname.slice('/api/backup/download/'.length));
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="collector.tar.age"','Content-Length':file.bytes,'Cache-Control':'no-store'});
        await pipeline(createReadStream(file.path),res);return;
      }
      if (url.pathname === '/api/state') { const policy=networkMode.status;json(res,{ token, network:policy, problems:problems.status, canQuit:Boolean(options.onShutdown), generation:store.generation,tags:store.tags(), favourites:store.favourites(), sources:store.followedSources(), feeds:store.feedSources().map(feed => ({...feed,report:reports.get(feed.name),offline:store.offlineMedia(feed.name),offlinePaused:policy.offline&&policy.paused.feeds.includes(feed.name), status:feedStatus(feed.name)})), targets:store.listTargets(), stats:store.stats(), job:{...jobs.state,requests:{...jobs.state.requests,sessionTotal:jobs.state.requests.sessionTotal+media.status.requests+archive.requests}},media:media.status,archives:archive.list(),
        storage:store.storage, import:importer.progress, imports:store.getSetting('imports') ?? [], account:store.getSetting('account') }); return; }
      if(url.pathname==='/api/media/issues'){json(res,store.incompleteMedia(url.searchParams.get('feed')??'',url.searchParams.get('after')));return;}
      if (url.pathname === '/api/feed') {
        json(res,store.queryFeed(feedQuery(url.searchParams)));return;
      }
      if (url.pathname.startsWith('/api/post/')) { const id=postId(url.pathname.slice('/api/post/'.length)); json(res,{post:store.getPost(id),snapshot:store.latestSnapshot(id)}); return; }
      if (url.pathname.startsWith('/api/media/')) {json(res,await media.view(postId(url.pathname.slice('/api/media/'.length))));return;}
      const asset=/^\/media\/((?:t3_[a-z0-9]+|tumblr:[a-z0-9-]+:[0-9]+))\/([a-f0-9]{64})$/.exec(url.pathname);
      if (asset) {await media.serve(postId(asset[1]!),asset[2]!,req.headers.range,res);return;}
      if (url.pathname.startsWith('/api/')) { json(res,{error:'Not found'},404); return; }
      const path = url.pathname === '/' ? resolve(dist,'index.html') : resolve(dist,'.' + decodeURIComponent(url.pathname));
      if (!path.startsWith(dist.endsWith(sep) ? dist : dist + sep)) { json(res,{error:'Not found'},404); return; }
      try {
        const content=await readFile(path);
        res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'} as Record<string,string>)[extname(path)] ?? 'application/octet-stream');
        res.end(content);
      } catch { json(res,{error:'UI missing. Run npm run build first.'},404); }
    } catch (error) {
      // Invalid user input is already shown by the requesting form. Only unexpected
      // runtime failures belong in the persistent problem log.
      if(error instanceof TypeError||error instanceof RangeError||/^ERR_SQLITE|^EIO$|^ENOSPC$/.test(String((error as NodeJS.ErrnoException)?.code??'')))problems.report({operation:'request'},error);
      if (!res.headersSent) json(res,{error:error instanceof Error ? error.message : 'Request failed'},400); else res.end();
    }
  };
  const server=createServer((req,res)=>{const work=handle(req,res);requests.add(work);void work.finally(()=>requests.delete(work));});
  const policySockets=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    const onSocketError=()=>socket.destroy();socket.on('error',onSocketError);
    try{
      const url=new URL(req.url??'/',origin),client=url.searchParams.get('client')??'';
      if(stopping||req.headers.host!==new URL(origin).host||req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'||url.pathname!=='/api/network/events'||url.searchParams.get('token')!==token||!/^[a-zA-Z0-9-]{1,80}$/.test(client)){
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n',()=>socket.destroy());return;
      }
      socket.removeListener('error',onSocketError);
      policySockets.handleUpgrade(req,socket,head,webSocket=>networkMode.subscribe(client,webSocket));
    }catch{socket.destroy();}
  });
  server.requestTimeout = 60 * 60_000;
  return { server, store, jobs, importer, media, archive, backups, networkMode, problems, async listen(port=options.port??Number(process.env.PORT??3210)) {
    await media.initialize();
    await new Promise<void>((resolve,reject)=>{
      const fail=(error:Error)=>{server.removeListener('listening',ready);reject(error);};
      const ready=()=>{server.removeListener('error',fail);resolve();};
      server.once('error',fail);server.once('listening',ready);server.listen(port,'127.0.0.1');
    });
    const address=server.address(); if (!address || typeof address === 'string') throw new Error('No local address');
    origin=`http://127.0.0.1:${address.port}`;lease?.publish(origin);return origin;
  }, close() {return closing??=(async()=>{
    stopping=true;
    networkMode.close();policySockets.close();
    const drained=new Promise<void>(resolve=>server.close(()=>resolve()));
    server.closeAllConnections();
    const failures:unknown[]=[];
    for(const close of [()=>backups.close(),()=>archive.close(),()=>importer.close(),()=>jobs.close(),()=>media.close()])try{await close();}catch(error){failures.push(error);}
    await Promise.allSettled([...requests]);await drained;
    // Do not release ownership while the primary database is still open, even
    // if a cache/temporary-file cleanup failed during shutdown.
    problems.close();store.close();lease?.release();
    if(temporaryMedia)try{await rm(mediaDirectory,{recursive:true,force:true});}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Collector stopped, but some temporary files could not be cleaned up');
  })();} };
  }catch(error){startupStore?.close();lease?.release();throw error;}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let closing:Promise<void>|null=null;
  const stop=()=>closing??=app.close();
  const app=createReaderServer({onShutdown:stop});
  try{console.log(`Collector: ${await app.listen()}`);}catch(error){await stop();throw error;}
  process.on('SIGINT',()=>void stop()); process.on('SIGTERM',()=>void stop());process.on('SIGHUP',()=>void stop());
}
