import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReaderStore } from './store.ts';
import { databasePath, dataDirectory } from './paths.ts';
import { ReaderJobs } from './jobs.ts';
import type { JobDependencies } from './jobs.ts';
import { ArchiveImporter } from './archive.ts';
import { ArchiveFetcher } from './archive-fetch.ts';
import { historyMonths, historyLowerBound, historyRank } from './history-window.ts';
import { MEDIA_KINDS, postId, subredditName } from './domain.ts';
import type { MediaKind } from './domain.ts';
import { MediaCache } from './media.ts';
import type { MediaDependencies } from './media.ts';
import { RequestQueue } from './request-gate.ts';
import { STORAGE_CAP_MESSAGE } from './storage-limit.ts';

export function createReaderServer(options: { database?: string; port?: number; archive?:{fetch?:typeof fetch}; jobs?: JobDependencies; media?: Partial<Pick<MediaDependencies,'directory'|'fetch'|'maxBytes'|'maxRequests'>> } = {}) {
  const store = new ReaderStore(options.database ?? databasePath);
  const network = options.jobs?.network ?? new RequestQueue({fromCompletion:true});
  let media: MediaCache;
  let archive:ArchiveFetcher;
  const jobs = new ReaderJobs(store, {...options.jobs,network,onPause:()=>{media?.stop();archive?.pause(store.getSetting<{reason:string}>('accessPause')?.reason??'Collection stopped; Resume archive to continue');options.jobs?.onPause?.();}});
  const temporaryMedia=options.database===':memory:'&&!options.media?.directory;
  const mediaDirectory=options.media?.directory??(temporaryMedia?join(tmpdir(),'reddit-reader-media-'+randomBytes(12).toString('hex')):join(dataDirectory,'media'));
  media = new MediaCache(store,{...options.media,directory:mediaDirectory,queue:network,onAccess:error=>jobs.accessFailure(error)});
  jobs.attachMedia(options.jobs?.mediaSync===undefined?media:options.jobs.mediaSync);
  const importer = new ArchiveImporter(store);
  archive=new ArchiveFetcher(store,{...options.archive,queue:network,assertCanStart:resume=>{
    if(importer.progress?.state==='running')throw new Error('Stop the file import before fetching an archive');
    jobs.assertCanQueue(resume);
  },onRunStart:()=>jobs.beginArchiveRun(),saveMedia:(ids,signal)=>jobs.archiveMedia(ids,signal)});
  const feedStatus=(name:string)=>archive.active?.subreddit===name&&archive.active.state==='running'?'syncing' as const:jobs.feedStatus(name)==='idle'?media.feedStatus(name):jobs.feedStatus(name);
  const token = randomBytes(32).toString('hex');
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  let origin = '';
  let cleaningContent=false;
  const cleanupPaths=new Set(['/api/remove','/api/clear-source','/api/delete-post','/api/clear']);
  const stopPaths=new Set(['/api/pause','/api/import/stop','/api/archive/stop','/api/sign-in/finish']);
  const assertCleanupIdle=(path:string)=>{if(cleaningContent&&!stopPaths.has(path))throw new Error('Content cleanup is still in progress. Try again when it finishes.');};
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); };
  const body = async (req: IncomingMessage) => {
    let content = ''; for await (const chunk of req) { content += chunk; if (content.length > 32_000) throw new Error('Request too large'); }
    return JSON.parse(content || '{}') as Record<string, unknown>;
  };
  const date = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const result = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid date');
    return result;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, { error: 'Local requests only' },403); return; }
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'POST') {
        const supplied = String(req.headers['x-reader-token'] ?? '');
        if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { json(res,{error:'Invalid local request token'},403); return; }
        assertCleanupIdle(url.pathname);
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
        const cleansContent=cleanupPaths.has(url.pathname);
        if(cleansContent)cleaningContent=true;
        try {
        switch (url.pathname) {
          case '/api/settings': {
            store.setStorageLimit(data.maxStoredBytes);
            if(store.storage.full){jobs.pause(STORAGE_CAP_MESSAGE);importer.stop();}
            json(res,{storage:store.storage});return;
          }
          case '/api/sources': {
            const name = subredditName(String(data.name ?? ''));
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
            if(typeof data.id==='string'&&job?.id!==data.id)throw new Error('This archive fetch is no longer active');
            await archive.stop();if(job){media.stop(job.subreddit);await jobs.stopSource(job.subreddit,'Archive stopped by user');}
            json(res,{ok:true});return;
          }
          case '/api/sync': {
            jobs.assertCanQueue(true);
            const followed = store.followedSources();
            const selected = Array.isArray(data.names) && data.names.length ? [...new Set(data.names.map(item => subredditName(String(item))))] : followed;
            if (selected.some(name => !followed.includes(name))) throw new Error('Sync requires a subscribed feed');
            if (!selected.length) throw new Error('Add a subreddit first');
            const names = selected.filter(name => feedStatus(name) === 'idle');
            json(res,{queued:jobs.syncFeeds(names)});return;
          }
          case '/api/history': {
            const name=subredditName(String(data.name)),months=historyMonths(data.months);
            if(archive.active?.subreddit===name)throw new Error('Stop the archive fetch before changing this feed’s history');
            if(!store.followedSources().includes(name))throw new Error('Subscribe to this feed first');
            const previous=store.getHistoryPreference(name),changed=previous.months!==months;
            const expanded=historyRank(months)>historyRank(previous.months);
            const shouldFetch=expanded;
            if(shouldFetch)jobs.assertCanQueue(true);
            if(changed&&jobs.feedStatus(name)!=='idle')await jobs.stopSource(name,expanded?'History limit expanded':'History limit reduced; collected posts retained');
            const result=store.setHistoryLimit(name,months);
            const targetId=shouldFetch?store.ensureHistoryTarget(name):result.targetId;
            if(targetId&&shouldFetch)jobs.syncFeeds([name],{heads:result.headTargetId?[result.headTargetId]:[],history:[targetId]});
            json(res,{...result,targetId,queued:Boolean(targetId&&jobs.hasTarget(targetId))});return;
          }
          case '/api/pause': if (typeof data.name === 'string') {await archive.stop(subredditName(data.name));media.stop(subredditName(data.name));await jobs.stopSource(data.name);} else {await archive.stop();jobs.pause();} break;
          case '/api/sign-in': await jobs.signIn(); break;
          case '/api/sign-in/finish': await jobs.finishSignIn(); break;
          case '/api/remove': {
            if (data.confirm !== true) throw new Error('Confirm feed removal first');
            const name = subredditName(String(data.name));
            await archive.stop(name,'Feed removed; stored archive progress kept');
            media.stop(name);
            await jobs.stopSource(name, 'Feed removed');await importer.stopSource(name);store.removeSubreddit(name); break;
          }
          case '/api/clear-source': {
            if(data.confirm!==true)throw new Error('Confirm clearing subreddit data first');
            const name=subredditName(String(data.name));
            if(!store.followedSources().includes(name))throw new Error('Choose a subscribed subreddit');
            await archive.stop(name,'Archive data cleared');
            await jobs.stopSource(name,'Data cleared');await importer.clearSource(name);
            const keys=store.ownedMediaKeys(name);
            store.clearSubreddit(name);await media.clearSource(name,keys);
            json(res,{ok:true,warning:store.compactionWarning});return;
          }
          case '/api/delete-post': {
            if(data.confirm!==true)throw new Error('Confirm deleting this post first');
            const id=postId(String(data.id));
            media.stopPost(id);await jobs.stopPost(id);
            const keys=store.deletePost(id),warning=store.compactionWarning;
            await media.clearPost(id,keys);json(res,{ok:true,warning});return;
          }
          case '/api/thread': jobs.thread(postId(String(data.id))); break;
          case '/api/clear': await archive.stop(undefined,'Archive data cleared');jobs.pause('Content cleared');await importer.clear();store.clearContent();await media.clear();store.setSetting('imports',[]);json(res,{ok:true,warning:store.compactionWarning});return;
          case '/api/import/stop': importer.stop(); break;
          default: json(res,{error:'Not found'},404); return;
        }
        json(res,{ok:true}); return;
        } finally {if(cleansContent)cleaningContent=false;}
      }
      if (req.method !== 'GET') { json(res,{error:'Method not allowed'},405); return; }
      if (url.pathname === '/api/state') { json(res,{ token, sources:store.followedSources(), feeds:store.feedSources().map(feed => ({...feed,offline:store.offlineMedia(feed.name), status:feedStatus(feed.name)})), targets:store.listTargets(), stats:store.stats(), job:{...jobs.state,requests:{...jobs.state.requests,sessionTotal:jobs.state.requests.sessionTotal+media.status.requests+archive.requests}},media:media.status,archives:archive.list(),
        storage:store.storage, import:importer.progress, imports:store.getSetting('imports') ?? [], account:store.getSetting('account') }); return; }
      if (url.pathname === '/api/feed') {
        const media = url.searchParams.get('media') ?? undefined;
        if (media && !MEDIA_KINDS.includes(media as MediaKind)) throw new Error('Invalid media filter');
        json(res,store.queryFeed({subreddit:url.searchParams.get('subreddit') || undefined,media:media as MediaKind | undefined,
          text:(url.searchParams.get('q') ?? '').slice(0,500),afterMs:date(url.searchParams.get('after')),beforeMs:date(url.searchParams.get('before')),
          cursor:url.searchParams.get('cursor') || undefined})); return;
      }
      if (url.pathname.startsWith('/api/post/')) { const id=postId(url.pathname.slice('/api/post/'.length)); json(res,{post:store.getPost(id),snapshot:store.latestSnapshot(id)}); return; }
      if (url.pathname.startsWith('/api/media/')) {json(res,await media.view(postId(url.pathname.slice('/api/media/'.length))));return;}
      const asset=/^\/media\/(t3_[a-z0-9]+)\/([a-f0-9]{64})$/.exec(url.pathname);
      if (asset) {await media.serve(postId(asset[1]!),asset[2]!,req.headers.range,res);return;}
      if (url.pathname.startsWith('/api/')) { json(res,{error:'Not found'},404); return; }
      const path = url.pathname === '/' ? resolve(dist,'index.html') : resolve(dist,'.' + decodeURIComponent(url.pathname));
      if (!path.startsWith(dist.endsWith(sep) ? dist : dist + sep)) { json(res,{error:'Not found'},404); return; }
      try {
        const content=await readFile(path);
        res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'} as Record<string,string>)[extname(path)] ?? 'application/octet-stream');
        res.end(content);
      } catch { json(res,{error:'UI missing. Run npm run build first.'},404); }
    } catch (error) { if (!res.headersSent) json(res,{error:error instanceof Error ? error.message : 'Request failed'},400); else res.end(); }
  });
  server.requestTimeout = 60 * 60_000;
  return { server, store, jobs, importer, media, archive, async listen() {
    await media.initialize();
    await new Promise<void>(resolve => server.listen(options.port ?? Number(process.env.PORT ?? 3210),'127.0.0.1',resolve));
    const address=server.address(); if (!address || typeof address === 'string') throw new Error('No local address');
    origin=`http://127.0.0.1:${address.port}`; return origin;
  }, async close() { await archive.close();await importer.close(); await jobs.close();await media.close();server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve()));store.close();if(temporaryMedia)await rm(mediaDirectory,{recursive:true,force:true}); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app=createReaderServer();
  console.log(`Reddit Reader: ${await app.listen()}`);
  let closing=false;
  const stop=async()=>{ if (closing) return; closing=true; await app.close(); process.exit(0); };
  process.on('SIGINT',()=>void stop()); process.on('SIGTERM',()=>void stop());
}
