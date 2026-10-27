import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StoredPost, HistoryTarget, FeedSource, OfflineMediaCounts } from '../src/store.ts';
import type { ThreadSnapshot } from '../src/extract.ts';
import type { ArchiveFetchState } from '../src/archive-fetch-state.ts';
import { historyLowerBound } from '../src/history-window.ts';
import { HISTORY_OPTIONS } from '../src/history-window.ts';
import type { HistoryMonths } from '../src/history-window.ts';
import { PostMedia } from './Media.tsx';
import {PostOrigin} from './PostOrigin.tsx';
import {REDDIT_PLATFORM,redditOrigin} from './reddit-presentation.ts';
import {useReadTracking} from './read-tracking.ts';
import {BackupSettings} from './BackupSettings.tsx';
import {StorageSettings} from './StorageSettings.tsx';
import { MEDIA_FILTERS } from '../src/domain.ts';
import { GB } from '../src/storage-limit.ts';
import {feedCursor} from '../src/feed-cursor.ts';
import {authorKey,authorLabel} from '../src/authors.ts';
import type {Author} from '../src/authors.ts';
import type { StorageStatus } from '../src/storage-limit.ts';
import './style.css';

type Feed = FeedSource & { offline:OfflineMediaCounts; status: 'idle' | 'queued' | 'syncing' | 'stopping' };
type State = {token:string;canQuit:boolean;favourites:{posts:number;users:Author[]};sources:string[];feeds:Feed[];targets:HistoryTarget[];storage:StorageStatus;stats:{posts:number;snapshots:number;mediaPosts:number;contentRevision:number;databaseBytes:number};
  job:{running:boolean;manual:boolean;queued:number;subreddit:string|null;message:string;requests:{released:number;suppressed:number;sessionTotal:number};accessPause:{reason:string;notBefore:number|null}|null};
  media:{pending:number;bytes:number;requests:number;revision:number};import:{state:string;lines:number;accepted:number;omitted:number;bytes:number;reason:string|null}|null;imports:unknown[];archives:(ArchiveFetchState&{offline:OfflineMediaCounts})[];account:string|null};
type Thread = {post:StoredPost;snapshot:ThreadSnapshot|null};
const date=(ms:number)=>new Date(ms).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
const timestamp=(ms:number|null)=>ms===null?'Never':new Date(ms).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const syncing=(feed:Feed)=>feed.status!=='idle';
const syncLabel=(feed:Feed)=>feed.sync.state==='incomplete'?'Resume':'Sync';
const syncState=(feed:Feed)=>feed.status==='syncing'?'Syncing':feed.status==='queued'?'Queued':feed.status==='stopping'?'Stopping':
  feed.sync.state==='complete'?'Saved offline':feed.sync.state==='gaps'?'Completed with gaps':feed.sync.state==='incomplete'?'Incomplete':'Not synced';
const storedSize=(bytes:number)=>bytes>=GB?`${(bytes/GB).toLocaleString(undefined,{maximumFractionDigits:2})} GB`:`${(bytes/1_000_000).toFixed(1)} MB`;
type Collection='all'|'posts'|'users';
const hashCollection=():Collection=>location.hash==='#favourites'?'posts':location.hash==='#users'?'users':'all';

function FavouriteButton({active,label,disabled,onClick}:{active:boolean;label:string;disabled:boolean;onClick:()=>void}){
  return <button className={'favourite-toggle'+(active?' active':'')} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}><svg width="15" height="15" viewBox="0 0 24 24" fill={active?'currentColor':'none'} stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg></button>;
}


function Modal({title,close,children,wide=false}:{title:string;close:()=>void;children:React.ReactNode;wide?:boolean}) {
  const ref=useRef<HTMLElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap=(event:KeyboardEvent)=>{
      if(event.key!=='Tab')return;
      const elements=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)')??[]);
      const first=elements[0],last=elements.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    ref.current?.addEventListener('keydown',trap);
    return()=>{ref.current?.removeEventListener('keydown',trap);previous?.focus();};
  },[]);
  return <div className="modal-backdrop"><section ref={ref} className={'modal '+(wide?'wide':'')} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-top"><h2>{title}</h2><button aria-label="Close dialog" onClick={close}>×</button></div>{children}
  </section></div>;
}

function App() {
  const [stopped,setStopped]=useState(false),stoppedRef=useRef(false);
  const [state,setState]=useState<State|null>(null),[posts,setPosts]=useState<StoredPost[]>([]),[next,setNext]=useState<string|null>(null);
  const postRows=useRef<StoredPost[]>([]),loadedQuery=useRef(''),loadedNext=useRef<string|null>(null),scrollAnchor=useRef<{id:string;top:number}|null>(null);
  const [view,setView]=useState(location.hash==='#feeds'?'feeds':'posts');
  const [collection,setCollection]=useState<Collection>(hashCollection),[userFilter,setUserFilter]=useState('');
  const [source,setSource]=useState(''),[media,setMedia]=useState(''),[search,setSearch]=useState('');
  const [searchScope,setSearchScope]=useState('both');
  const [readFilter,setReadFilter]=useState('all'),[readBefore,setReadBefore]=useState(Date.now);
  const suppressedReads=useRef(new Set<string>()),readRequests=useRef(new Map<string,number>()),readSequence=useRef(0),readChanges=useRef(0),readResults=useRef(new Map<string,{version:number;context:string;readAt:number|null}>());
  const [readClient]=useState(()=>crypto.randomUUID());
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[modal,setModal]=useState<'source'|'history'|'import'|'clear'|'settings'|'storage'|null>(null),[removeFeed,setRemoveFeed]=useState<string|null>(null);
  const [loadErrors,setLoadErrors]=useState({state:'',feed:''}),retryFeed=useRef(false);
  const visibleError=error||loadErrors.state||loadErrors.feed;
  const [clearFeed,setClearFeed]=useState<string|null>(null);
  const [postToDelete,setPostToDelete]=useState<Pick<StoredPost,'id'|'title'|'subreddit'>|null>(null);
  const [storageGb,setStorageGb]=useState('10'),[storageSaved,setStorageSaved]=useState(false);
  const [name,setName]=useState(''),[months,setMonths]=useState<HistoryMonths>(1);
  const [thread,setThread]=useState<Thread|null>(null);
  const [upload,setUpload]=useState<File|null>(null),[importSource,setImportSource]=useState(''),[importPostIds,setImportPostIds]=useState(''),[importBusy,setImportBusy]=useState(false);
  const [archiveMode,setArchiveMode]=useState<'fetch'|'file'>('fetch'),[archiveName,setArchiveName]=useState('');
  const [archiveFrom,setArchiveFrom]=useState(()=>new Date(historyLowerBound(1,Date.now())!).toISOString().slice(0,10)),[archiveTo,setArchiveTo]=useState(()=>new Date().toISOString().slice(0,10));
  const token=useRef(''),feedVersion=useRef(0),threadId=useRef<string|null>(null),pollVersion=useRef(''),stateVersion=useRef(0),currentQuery=useRef('');
  const feedChange=useRef(0),renderedFeedChange=useRef(0);
  const favouriteUsers=state?.favourites?.users??[],selectedAuthor=favouriteUsers.find(author=>authorKey(author)===userFilter);
  const params=new URLSearchParams();if(source)params.set('subreddit',source);if(media)params.set('media',media);if(search)params.set('q',search);
  if(collection!=='all')params.set('favourites',collection);
  if(collection==='users'&&selectedAuthor){params.set('authorPlatform',selectedAuthor.platform);params.set('authorId',selectedAuthor.id);}
  params.set('read',readFilter);params.set('readBefore',String(readBefore));
  params.set('scope',searchScope);
  if(currentQuery.current!==params.toString()){currentQuery.current=params.toString();feedVersion.current++;}
  const feeds=state?.feeds??[],activeFeeds=feeds.filter(syncing),pending=state?.targets.filter(target=>['queued','paused'].includes(target.status))??[];
  const count=source?feeds.find(feed=>feed.name===source)?.postCount??0:feeds.reduce((sum,feed)=>sum+feed.postCount,0);
  const currentFeed=feeds.find(feed=>feed.name===source);
  const archiveActive=state?.archives.find(job=>job.state==='running');
  function openArchives(){setArchiveName(old=>old||source||state?.sources[0]||'');setError('');setModal('import');}
  function navigate(nextView:string){location.hash=nextView;setView(nextView==='feeds'?'feeds':'posts');setCollection(nextView==='favourites'?'posts':nextView==='users'?'users':'all');setUserFilter('');}
  function openFavourites(nextView:'favourites'|'users'){setSource('');navigate(nextView);}
  function filterSource(name:string){setSource(name);navigate('posts');}
  function showFeedView(){if(view==='feeds')navigate('posts');}
  function selectSource(name:string){setSource(name);setReadBefore(Date.now());showFeedView();}
  function openSettings(){setStorageGb(String((state?.storage.limitBytes??10*GB)/GB));setStorageSaved(false);setError('');setModal('settings');}
  async function get<T>(path:string):Promise<T>{const response=await fetch(path).catch(()=>{throw new Error('Cannot connect to Collector. Make sure the local app is running; retrying automatically.');});const value=await response.json();if(!response.ok)throw new Error(value.error);return value;}
  function loadError(kind:'state'|'feed',message:string){setLoadErrors(old=>old[kind]===message?old:{...old,[kind]:message});}
  async function loadState(){
    const version=++stateVersion.current;
    try{
      const value=await get<State>('/api/state');
      if(stoppedRef.current||version!==stateVersion.current)return null;
      const revision=JSON.stringify([value.stats.posts,value.stats.snapshots,value.stats.mediaPosts,value.stats.contentRevision,value.feeds.map(feed=>[feed.name,feed.postCount,feed.sync.lastSuccessAt])]);
      const contentChanged=revision!==pollVersion.current;pollVersion.current=revision;
      if(contentChanged)feedChange.current++;
      token.current=value.token;setState(value);loadError('state','');return{...value,contentChanged};
    }catch(e){if(!stoppedRef.current&&version===stateVersion.current)loadError('state',(e as Error).message);return null;}
  }
  function showPosts(rows:StoredPost[]){postRows.current=rows;setPosts(rows);}
  async function loadFeed(append=false){
    const version=++feedVersion.current,key=currentQuery.current,same=loadedQuery.current===key,confirmedReads=readChanges.current,change=feedChange.current;
    try{
      const more=append&&same&&postRows.current.length>0;
      if(more&&!loadedNext.current)return;
      const oldest=!more&&same?postRows.current.at(-1):null;
      let cursor=more?loadedNext.current:null,after:string|null=null,rows:StoredPost[]=[];
      const visited=new Set<string>(),atOrPast=(a:StoredPost,b:StoredPost)=>a.createdMs<b.createdMs||(a.createdMs===b.createdMs&&a.id<=b.id);
      do{
        const q=new URLSearchParams(key);if(cursor)q.set('cursor',cursor);
        const result=await get<{posts:StoredPost[];next:string|null}>('/api/feed?'+q);
        if(stoppedRef.current||version!==feedVersion.current||key!==currentQuery.current)return;
        rows.push(...result.posts);after=result.next;
        if(oldest&&result.posts.length&&atOrPast(result.posts.at(-1)!,oldest)){
          const retained=rows.filter(post=>atOrPast(oldest,post));
          if(retained.length){const older=retained.length<rows.length||Boolean(after);rows=retained;after=older?feedCursor(rows.at(-1)!):null;}
          break;
        }
        if(after&&visited.has(after))throw new Error('The feed changed while loading. Refresh view and try again.');
        if(after)visited.add(after);cursor=after;
      }while(!more&&oldest&&after);
      if(same&&!more){const visible=[...document.querySelectorAll<HTMLElement>('.post-card[data-post-id]')].find(card=>{const box=card.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight;});if(visible)scrollAnchor.current={id:visible.dataset.postId!,top:visible.getBoundingClientRect().top};}
      rows=rows.map(post=>{const read=readResults.current.get(post.id);return read&&read.version>confirmedReads&&read.context===post.readContext?{...post,readAt:read.readAt}:post;});
      const unique=new Map((more?[...postRows.current,...rows]:rows).map(post=>[post.id,post]));
      showPosts([...unique.values()]);readResults.current.clear();loadedQuery.current=key;loadedNext.current=after;setNext(after);
      // Appending older rows does not replace a cancelled refresh of newer rows.
      if(!more)renderedFeedChange.current=change;
      retryFeed.current=false;loadError('feed','');
    }catch(e){if(!stoppedRef.current&&version===feedVersion.current&&key===currentQuery.current){retryFeed.current=true;loadError('feed',(e as Error).message);}}
  }
  useLayoutEffect(()=>{const anchor=scrollAnchor.current;scrollAnchor.current=null;if(!anchor)return;const card=[...document.querySelectorAll<HTMLElement>('.post-card[data-post-id]')].find(card=>card.dataset.postId===anchor.id);if(card)window.scrollBy(0,card.getBoundingClientRect().top-anchor.top);},[posts]);
  async function action(path:string,data:unknown={}){
    setError('');setBusy(true);
    try{const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token.current},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new Error(value.error);if(value.warning)setError(value.warning);await loadState();await loadFeed();return value;}
    catch(e){setError((e as Error).message);return null;}finally{setBusy(false);}
  }
  useEffect(()=>{void loadState();const hash=()=>{setView(location.hash==='#feeds'?'feeds':'posts');setCollection(hashCollection());};window.addEventListener('hashchange',hash);return()=>window.removeEventListener('hashchange',hash);},[]);
  async function togglePostFavourite(post:StoredPost){const result=await action('favourite/post',{id:post.id,context:post.readContext,favourite:!post.favourite});if(result?.post)setThread(old=>old?.post.id===post.id&&old.post.readContext===post.readContext?{...old,post:{...old.post,favourite:result.post.favourite}}:old);}
  async function toggleUserFavourite(author:Author,active:boolean){const result=await action('favourite/user',{author,favourite:!active});if(result&&active&&userFilter===authorKey(author))setUserFilter('');if(result)setThread(old=>old?.post.author&&authorKey(old.post.author)===authorKey(author)?{...old,post:{...old.post,favouriteUser:!active}}:old);}
  function authorControls(post:StoredPost){return post.author&&<span className="post-author"><span>{authorLabel(post.author)}</span><FavouriteButton active={post.favouriteUser} label={(post.favouriteUser?'Unfavourite user: ':'Favourite user: ')+authorLabel(post.author)} disabled={busy} onClick={()=>void toggleUserFavourite(post.author!,post.favouriteUser)}/></span>;}
  const markRead=useCallback(async(id:string,read=true)=>{
    const context=postRows.current.find(post=>post.id===id)?.readContext;if(!context)return;
    const version=++readSequence.current;readRequests.current.set(id,version);
    try{
      const response=await fetch('/api/read',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token.current},body:JSON.stringify({id,read,client:readClient,sequence:version,context})});
      const value=await response.json();if(stoppedRef.current||readRequests.current.get(id)!==version)return;if(!response.ok)throw new Error(value.error);
      readResults.current.set(id,{version:++readChanges.current,context,readAt:value.post.readAt});
      showPosts(postRows.current.map(post=>post.id===id&&post.readContext===context?{...post,readAt:value.post.readAt}:post));
      setThread(old=>old?.post.id===id&&old.post.readContext===context?{...old,post:{...old.post,readAt:value.post.readAt}}:old);
    }catch(error){if(!stoppedRef.current&&readRequests.current.get(id)===version)setError((error as Error).message);throw error;}
    finally{if(readRequests.current.get(id)===version)readRequests.current.delete(id);}
  },[]);
  useReadTracking(!stopped&&view==='posts'&&!modal&&!thread&&!removeFeed&&!clearFeed&&!postToDelete&&Boolean(state),markRead,suppressedReads.current);
  useEffect(()=>{if(state&&userFilter&&!selectedAuthor)setUserFilter('');},[Boolean(state),userFilter,selectedAuthor?.platform,selectedAuthor?.id]);
  useEffect(()=>{if(state&&view==='posts'&&collection==='all'&&source&&!state.sources.includes(source))setSource('');},[state?.sources,view,collection,source]);
  useEffect(()=>setReadBefore(Date.now()),[source,media,search,searchScope,collection,userFilter]);
  useEffect(()=>{const timer=setTimeout(()=>void loadFeed(),200);return()=>clearTimeout(timer);},[source,media,search,searchScope,readFilter,readBefore,collection,userFilter,selectedAuthor?.id,selectedAuthor?.platform]);
  useEffect(()=>{
    let pending=false,disposed=false;
    const timer=setInterval(()=>{
      if(pending||stoppedRef.current)return;pending=true;
      void loadState().then(async value=>{
        if(!value||disposed||stoppedRef.current)return;
        if(value.contentChanged||retryFeed.current||renderedFeedChange.current!==feedChange.current)await loadFeed();
        const id=threadId.current;
        if(id){const result=await get<Thread>('/api/post/'+id);if(threadId.current===id){if(result.post)setThread(result);else{setThread(null);threadId.current=null;}}}
      }).catch(e=>{if(!disposed&&!stoppedRef.current)setError(e.message);}).finally(()=>{pending=false;});
    },2000);
    return()=>{disposed=true;clearInterval(timer);};
  },[]);
  useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy){setModal(null);setRemoveFeed(null);setClearFeed(null);setPostToDelete(null);setThread(null);threadId.current=null;}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[busy]);
  async function openThread(id:string){threadId.current=id;try{const value=await get<Thread>('/api/post/'+id);if(threadId.current===id&&value.post)setThread(value);}catch(e){if(threadId.current===id)setError((e as Error).message);}}
  async function importFile(){
    if(!upload)return;setImportBusy(true);setError('');
    try{const q=new URLSearchParams({subreddit:importSource||state?.sources[0]||'',filename:upload.name,size:String(upload.size),modified:String(upload.lastModified),postIds:importPostIds.trim().split(/[\s,]+/).filter(Boolean).join(',')});
      const response=await fetch('/api/import?'+q,{method:'POST',headers:{'X-Reader-Token':token.current},body:upload});const value=await response.json();if(!response.ok)throw new Error(value.error);if(value.state==='paused')setError(value.reason);await loadState();await loadFeed();
    }catch(e){setError((e as Error).message);}finally{setImportBusy(false);}
  }
  async function quit(){
    setBusy(true);setError('');
    try{const response=await fetch('/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token.current},body:'{}'});const value=await response.json();if(!response.ok)throw new Error(value.error);stoppedRef.current=true;stateVersion.current++;feedVersion.current++;setStopped(true);}
    catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  if(stopped)return <div className="empty-state" role="status"><h1>Collector stopped</h1><p>Close this tab, or relaunch Collector.command to keep reading.</p></div>;
  const feedSync=(feed:Feed)=>syncing(feed)?<button className="button stop" disabled={busy||feed.status==='stopping'} onClick={()=>void action('pause',{name:feed.name})} aria-label={'Stop r/'+feed.name}>{feed.status==='stopping'?'Stopping…':'Stop'}</button>:
    <button className="button" disabled={busy||Boolean(state?.job.manual)} onClick={()=>void action('sync',{names:[feed.name]})} aria-label={syncLabel(feed)+' r/'+feed.name}>{syncLabel(feed)}</button>;
  return <div className="app">
    <aside className="sidebar">
      <a className="brand" href="#posts" onClick={()=>filterSource('')}><span className="brand-mark" aria-hidden="true">C</span> Collector</a>
      <nav aria-label="Main navigation"><button className={'nav-item '+(view==='feeds'?'active':'')} onClick={()=>navigate('feeds')}>Feeds <span>{feeds.length}</span></button><button className={'nav-item '+(view==='posts'&&collection==='posts'?'active':'')} onClick={()=>openFavourites('favourites')}>Favourite posts <span>{state?.favourites?.posts??0}</span></button><button className={'nav-item '+(view==='posts'&&collection==='users'?'active':'')} onClick={()=>openFavourites('users')}>Favourite users <span>{favouriteUsers.length}</span></button></nav>
      <section className="sidebar-filters" aria-label="Search and filters">
        <label className="sidebar-search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input type="search" maxLength={500} title="Literal search of saved post text. Longer terms are faster in large libraries." className="search" aria-label="Search stored posts" placeholder="Search posts…" value={search} onChange={e=>{setSearch(e.target.value);showFeedView();}}/></label>
        <div className="sidebar-filter"><label htmlFor="search-scope">Search in</label><select id="search-scope" aria-label="Search scope" value={searchScope} onChange={e=>{setSearchScope(e.target.value);showFeedView();}}><option value="both">Title + body</option><option value="title">Title</option><option value="body">Body</option></select></div>
        <div className="sidebar-filter"><label htmlFor="read-status">Show</label><select id="read-status" aria-label="Read status" value={readFilter} onChange={e=>{setReadFilter(e.target.value);setReadBefore(Date.now());showFeedView();}}><option value="all">Read+Unread</option><option value="unread">Unread</option><option value="read">Read</option></select></div>
      </section>
      <div className="source-nav" role="group" aria-label="Feed filter"><button className={'source-item '+(!source&&view==='posts'?'selected':'')} aria-pressed={!source&&view==='posts'} onClick={()=>selectSource('')}><span>All feeds</span><span className="source-count">{feeds.reduce((sum,feed)=>sum+feed.postCount,0)}</span></button>
        <section className="source-platform" aria-labelledby="reddit-feed-heading"><h2 className="source-heading" id="reddit-feed-heading">{REDDIT_PLATFORM.label}</h2><div className="platform-feeds">
          {feeds.map(feed=><button className={'source-item '+(source===feed.name&&view==='posts'?'selected':'')} aria-pressed={source===feed.name&&view==='posts'} key={feed.name} onClick={()=>selectSource(feed.name)}>
            <span>{redditOrigin(feed.name).feed.label}</span>{syncing(feed)?<span className={'status-dot '+(feed.status==='syncing'?'pulse':'')} title={feed.status}/>:<span className="source-count">{feed.postCount}</span>}
          </button>)}
          {source&&!feeds.some(feed=>feed.name===source)&&<button className={'source-item '+(view==='posts'?'selected':'')} aria-pressed={view==='posts'} onClick={()=>selectSource(source)}>{redditOrigin(source).feed.label} (stored)</button>}
        </div></section>
      </div>
      <div className="sidebar-bottom"><dl className="sidebar-stats" aria-label="Storage and requests">
        <div className={'storage-stat '+(state?.storage.full?'at-cap':'')}><dt>Stored</dt><dd><span>{(state?.storage.percentUsed??0).toFixed(2)}% used</span><small>{storedSize(state?.storage.usedBytes??0)} / {storedSize(state?.storage.limitBytes??10*GB)}</small></dd></div>
        <div title="Collection requests: a fresh random 4–6 second gap after each response is ready. Online players stream separately."><dt>Request spacing</dt><dd>4–6 s</dd></div>
        <div title="Collection requests only; excludes online video players"><dt>Session requests</dt><dd>{(state?.job.requests.sessionTotal??0).toLocaleString()}</dd></div>
      </dl><button onClick={()=>setModal('history')}>Collection history <span>{pending.length||''}</span></button><button onClick={openArchives}>Import an archive</button>
        <button className="settings-button" onClick={openSettings}>Settings</button>
      </div>
    </aside>
    <main>
      <header className="page-header"><div><h1>{view==='feeds'?'Feeds':collection==='posts'?'Favourite posts':collection==='users'?'Favourite users':source?redditOrigin(source).feed.label:'All feeds'}</h1><span className="header-meta">{view==='feeds'?`${feeds.length} subscribed feeds`:collection==='posts'?`${state?.favourites?.posts??0} favourite ${(state?.favourites?.posts??0)===1?'post':'posts'}`:collection==='users'?`${favouriteUsers.length} favourite ${favouriteUsers.length===1?'user':'users'}`:`${count.toLocaleString()} stored posts`}</span></div>
        <div className="header-actions">{state?.job.manual?<button className="button primary" disabled={busy} onClick={()=>void action('sign-in/finish')}>Finish sign-in</button>:<>
          {activeFeeds.length>0&&<button className="button stop" disabled={busy} onClick={()=>void action('pause')}>Stop all</button>}
          {view==='posts'&&currentFeed?feedSync(currentFeed):<button className="button" disabled={busy||!feeds.length||feeds.every(syncing)} onClick={()=>void action('sync')}>Sync all</button>}
        </>}{view==='feeds'&&<button className="button primary" onClick={()=>{setName('');setMonths(1);setModal('source');}}>＋ Add feed</button>}</div>
      </header>
      {visibleError&&!modal&&!removeFeed&&!clearFeed&&!postToDelete&&<div className="notice error" role="alert"><span>{visibleError}</span><button aria-label="Dismiss error" onClick={()=>{setError('');setLoadErrors({state:'',feed:''});}}>×</button></div>}
      {state?.storage.full&&<div className="notice"><span>Storage cap reached. Existing content is kept; increase the cap to continue collecting.</span><button className="button" onClick={openSettings}>Storage settings</button></div>}
      {state?.job.accessPause&&<div className="notice">{state.job.accessPause.reason}<button className="button" disabled={busy} onClick={()=>void action('sync')}>Resume sync</button></div>}
      {archiveActive&&<div className="sync-bar archive-sync" role="status"><span className="status-dot pulse"/><span>r/{archiveActive.subreddit} · {archiveActive.phase==='media'?'Saving archive media':'Fetching archive'} · {archiveActive.observed.toLocaleString()} posts checked</span><button onClick={openArchives}>Progress</button><button disabled={busy} onClick={()=>void action('archive/stop',{id:archiveActive.id})}>Stop archive</button></div>}
      {(state?.job.running||Boolean(state?.media.pending))&&<div className="sync-bar" role="status"><span className="status-dot pulse"/><span>{state!.job.running?state!.job.message:`Loading media · ${state!.media.pending} files queued`}</span>{state!.job.queued>0&&<span className="muted">{state!.job.queued} queued</span>}
        {state!.job.subreddit&&<button onClick={()=>void action('pause',{name:state!.job.subreddit})} disabled={busy}>Stop r/{state!.job.subreddit}</button>}
      </div>}
      {!state?<div className="empty-state" role="status"><h2>{loadErrors.state?'Waiting for Collector':'Loading Collector…'}</h2><p>Connecting to your local library.</p></div>:view==='feeds'?<section className="feeds-page" aria-label="Subscribed feeds">
        {feeds.length?<><div className="feed-list">
          {feeds.map(feed=><article className="feed-card" key={feed.name} data-feed={feed.name} aria-labelledby={'feed-title-'+feed.name}>
            <header className="feed-card-header">
              <div className="feed-identity"><h2 id={'feed-title-'+feed.name}><button onClick={()=>filterSource(feed.name)}>r/{feed.name}</button></h2><p><span>{feed.postCount.toLocaleString()} posts</span><span className="feed-provenance">{feed.liveCount.toLocaleString()} live{feed.archiveCount>0?` · ${feed.archiveCount.toLocaleString()} archive`:''}{feed.historyTarget?.omissionCount?` · ${feed.historyTarget.omissionCount} omitted`:''}</span></p></div>
              <div className="feed-header-actions"><span className={'status-label '+(syncing(feed)?feed.status:feed.sync.state==='incomplete'||feed.sync.state==='gaps'?'stopped':'')}><i/>{syncState(feed)}</span>{feedSync(feed)}</div>
            </header>
            <div className="feed-card-body">
              <section className="feed-detail-group" aria-label={'Activity for r/'+feed.name}><h3>Activity</h3><dl className="feed-facts">
                <div><dt>Last successful sync:</dt><dd><time dateTime={feed.sync.lastSuccessAt?new Date(feed.sync.lastSuccessAt).toISOString():undefined}>{timestamp(feed.sync.lastSuccessAt)}</time></dd></div>
                {feed.sync.lastCompletedAt&&feed.sync.lastCompletedAt!==feed.sync.lastSuccessAt&&<div><dt>Last completed:</dt><dd><time dateTime={new Date(feed.sync.lastCompletedAt).toISOString()}>{timestamp(feed.sync.lastCompletedAt)}</time></dd></div>}
                {feed.sync.startedAt&&<div><dt>Last attempt:</dt><dd><time dateTime={new Date(feed.sync.startedAt).toISOString()}>{timestamp(feed.sync.startedAt)}</time></dd></div>}
              </dl>{feed.text.total>0&&<p className="feed-media-note">Text {feed.text.ready}/{feed.text.total} offline{feed.text.pending?` · ${feed.text.pending} awaiting sync`:''}{feed.text.failed?` · ${feed.text.failed} retryable`:''}</p>}{feed.offline.total>0&&<p className="feed-media-note" title={`${feed.offline.pending} pending · ${feed.offline.failed} failed · ${feed.offline.unavailable} unavailable`}>Media {feed.offline.ready}/{feed.offline.total} offline{feed.offline.pending>0?` · ${feed.offline.pending} awaiting sync`:''}{feed.offline.failed>0?` · ${feed.offline.failed} retryable`:''}{feed.offline.unavailable>0?` · ${feed.offline.unavailable} unavailable`:''}</p>}</section>
              <section className="feed-detail-group" aria-label={'Stored history for r/'+feed.name}><h3>Stored history</h3>{feed.oldestMs!==null?<dl className="feed-facts">
                <div><dt>Newest:</dt><dd><time dateTime={new Date(feed.newestMs!).toISOString()}>{timestamp(feed.newestMs!)}</time></dd></div>
                <div><dt>Oldest:</dt><dd><time dateTime={new Date(feed.oldestMs).toISOString()}>{timestamp(feed.oldestMs)}</time></dd></div>
              </dl>:<p className="feed-no-history">No history collected</p>}</section>
            </div>
            {feed.sync.reason&&!syncing(feed)&&<p className="feed-issue"><span aria-hidden="true">!</span>{feed.sync.reason}</p>}
            {feed.sync.state==='incomplete'&&!syncing(feed)&&<p className="feed-resume-note">Resume continues unfinished history and retries pending or failed downloads.</p>}
            <footer className="feed-card-footer">
              <div className="feed-history-settings"><div className="feed-history-controls"><label htmlFor={'history-'+feed.name}>History limit</label><select id={'history-'+feed.name} aria-label={'History limit for r/'+feed.name} aria-describedby="feed-history-note" value={feed.historyMonths} disabled={busy||state?.job.manual} onChange={e=>void action('history',{name:feed.name,months:Number(e.target.value)})}>{HISTORY_OPTIONS.map(option=><option key={option.months} value={option.months}>{option.label}</option>)}</select>
              </div></div>
              <div className="feed-row-actions" role="group" aria-label={'Manage r/'+feed.name}><button disabled={busy} aria-label={'Clear data for r/'+feed.name} onClick={()=>{setError('');setClearFeed(feed.name);}}>Clear data</button><button disabled={busy} aria-label={'Remove r/'+feed.name} onClick={()=>setRemoveFeed(feed.name)}>Remove feed</button></div>
            </footer>
          </article>)}
        </div><p className="feed-page-note" id="feed-history-note">Sync saves recent posts, unfinished history and supported media locally. Expanding the history limit starts a sync; reducing it keeps saved posts. Older archives and stored date ranges may have gaps.</p></>:<div className="empty-state"><h2>No feeds yet</h2><button className="button primary" onClick={()=>{setName('');setMonths(1);setModal('source');}}>Add a feed</button></div>}
      </section>:<>
        {collection==='users'&&<section className="favourite-users" aria-label="Favourited users"><p>Posts already stored in Collector, across all your favourite users. New posts appear when you sync their feeds.</p><div className="user-chips"><button className={'user-filter'+(!selectedAuthor?' selected':'')} onClick={()=>setUserFilter('')}>All favourite users</button>{favouriteUsers.map(author=><div className="user-chip" key={authorKey(author)}><button className={'user-filter'+(selectedAuthor&&authorKey(selectedAuthor)===authorKey(author)?' selected':'')} onClick={()=>setUserFilter(authorKey(author))}>{authorLabel(author)}</button><FavouriteButton active label={'Unfavourite user: '+authorLabel(author)} disabled={busy} onClick={()=>void toggleUserFavourite(author,true)}/></div>)}</div></section>}
        <section className="feed-tools" aria-label="Feed filters"><div className="type-tabs">{['',...MEDIA_FILTERS].map(type=><button key={type} className={media===type?'selected':''} onClick={()=>setMedia(type)}>{type||'All posts'}</button>)}</div></section>
        <div className="feed-meta"><span>Newest first · <button onClick={()=>setReadBefore(Date.now())}>Refresh view</button></span>{currentFeed?<span>Last successful sync: {timestamp(currentFeed.sync.lastSuccessAt)} · {syncState(currentFeed)}{currentFeed.offline.total>0&&` · Media ${currentFeed.offline.ready}/${currentFeed.offline.total} offline`}</span>:<button onClick={()=>navigate('feeds')}>Manage feeds &amp; sync status →</button>}</div>
        <div className="feed">{posts.map(post=><article className={"post-card "+(post.readAt!==null?"is-read":"")} data-post-id={post.id} data-read={post.readAt!==null} key={post.id}>
          <div className="post-content"><PostMedia post={post} revision={state?.media.revision??0} syncing={Boolean(feeds.find(feed=>feed.name===post.subreddit)&&syncing(feeds.find(feed=>feed.name===post.subreddit)!))}>
            {mediaControls=><><div className="post-meta"><PostOrigin origin={redditOrigin(post.subreddit)} onSelectFeed={origin=>selectSource(origin.feed.id)}/>{authorControls(post)}<time dateTime={new Date(post.createdMs).toISOString()}>{date(post.createdMs)}</time>{post.source==='archive'&&<span className="archive-label">Archive</span>}<div className="badges">{post.media.map(type=><span key={type}>{type}</span>)}{post.availability!=='available'&&<span>{post.availability}</span>}{mediaControls}</div></div>
            <button className="post-title" onClick={()=>void openThread(post.id)}>{post.title}</button>{media!=='Media'&&post.body&&<p className="post-preview">{post.body.slice(0,200)}</p>}</>}
          </PostMedia>
          </div><div className="post-actions"><FavouriteButton active={post.favourite} label={(post.favourite?'Unfavourite post: ':'Favourite post: ')+post.title} disabled={busy} onClick={()=>void togglePostFavourite(post)}/><button className="read-toggle" title={post.readAt!==null?"Mark unread":"Mark read"} aria-label={(post.readAt!==null?"Mark unread: ":"Mark read: ")+post.title} onClick={()=>{const read=post.readAt===null;if(!read)suppressedReads.current.add(post.id);else suppressedReads.current.delete(post.id);void markRead(post.id,read).catch(()=>{});}}>{post.readAt!==null?"●":"○"}</button><button className="read-thread" onClick={()=>void openThread(post.id)} aria-label={'Read thread: '+post.title}>↗</button><button className="delete-post danger" title="Delete post" disabled={busy} aria-label={'Delete post: '+post.title} onClick={()=>{setError('');setPostToDelete(post);}}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button></div>
        </article>)}</div>
        {!posts.length&&<div className="empty-state"><h2>{collection==='posts'?'No matching favourite posts':collection==='users'?'No matching posts from favourite users':feeds.length?'No matching posts':'No feeds yet'}</h2><p>{collection==='posts'?'Use the star on a post to keep it here, or adjust your filters.':collection==='users'?'Use the star beside an author’s name to favourite them. Older posts without author details gain them when synced or imported again.':feeds.length?'Refresh a feed or adjust your filters.':'Add a feed to get started.'}</p>{collection==='all'&&!feeds.length&&<button className="button primary" onClick={()=>navigate('feeds')}>Manage feeds</button>}</div>}
        {next&&<button className="button load-more" onClick={()=>void loadFeed(true)}>Load more</button>}
      </>}
    </main>
    {thread&&<div className="drawer-backdrop" onClick={()=>{setThread(null);threadId.current=null;}}><section className="thread-drawer" role="dialog" aria-modal="true" aria-label="Thread details" onClick={e=>e.stopPropagation()}>
      <div className="drawer-top"><span><PostOrigin origin={redditOrigin(thread.post.subreddit)}/> · {date(thread.post.createdMs)}</span><button autoFocus aria-label="Close thread" onClick={()=>{setThread(null);threadId.current=null;}}>×</button></div><h2>{thread.post.title}</h2>
      <div className="thread-author">{authorControls(thread.post)}<FavouriteButton active={thread.post.favourite} label={(thread.post.favourite?'Unfavourite post: ':'Favourite post: ')+thread.post.title} disabled={busy} onClick={()=>void togglePostFavourite(thread.post)}/></div>
      <div className="thread-actions"><button className="button" disabled={busy} onClick={()=>void action('thread',{id:thread.post.id})}>{thread.snapshot?'Re-read discussion':'Read discussion in browser'}</button><button className="button danger" disabled={busy} onClick={()=>{setError('');setPostToDelete(thread.post);}}>Delete post</button><a href={thread.post.permalink} target="_blank" rel="noreferrer">Open original post ↗</a></div>
      <PostMedia post={thread.post} revision={state?.media.revision??0} syncing={Boolean(feeds.find(feed=>feed.name===thread.post.subreddit)&&syncing(feeds.find(feed=>feed.name===thread.post.subreddit)!))}>
        {mediaControls=><div className="badges thread-media-badges">{thread.post.media.map(type=><span key={type}>{type}</span>)}{mediaControls}</div>}
      </PostMedia>
      <div className="prose">{thread.post.body??thread.snapshot?.body??(thread.post.availability!=='available'?'Post '+thread.post.availability+'.':thread.post.media.includes('Text')?'Post body has not been read.':'')}</div>
      {thread.snapshot?<><div className="sample-note"><strong>{thread.snapshot.comments.length} sampled comments · {thread.snapshot.source} · sort: {thread.snapshot.sort}</strong><p>{thread.snapshot.sample}. Read {timestamp(thread.snapshot.observedAt)}.</p><p>{thread.snapshot.omitted} known omissions. Capture time: {timestamp(thread.snapshot.capturedAt)}.</p></div>
        <div className="comments">{thread.snapshot.comments.map(comment=><article key={comment.id} className="comment"><div>{comment.id} {comment.ancestry==='unresolved'?'· parent unavailable':comment.parentId?.startsWith('t1_')?'· reply to '+comment.parentId:'· top-level'}</div><p>{comment.availability==='available'?comment.body:'['+comment.availability+']'}</p></article>)}</div>
      </>:<p className="sample-note">Read discussion saves up to 100 initially rendered comments. Collapsed and unloaded branches are omitted.</p>}
    </section></div>}
    {removeFeed&&<Modal title={'Remove r/'+removeFeed+'?'} close={()=>setRemoveFeed(null)}><p>This stops its sync and removes it from your subscribed feeds. Collected content and history remain stored.</p><div className="dialog-actions"><button className="button" onClick={()=>setRemoveFeed(null)}>Keep feed</button><button className="button danger" disabled={busy} onClick={()=>{const name=removeFeed;void action('remove',{name,confirm:true}).then(result=>{if(result){if(source===name)setSource('');setRemoveFeed(null);}});}}>Remove feed</button></div>{error&&<p className="notice error" role="alert">{error}</p>}</Modal>}
    {postToDelete&&<Modal title="Delete this post?" close={()=>setPostToDelete(null)}><p className="delete-post-title">{postToDelete.title}</p><p>Delete this post and its saved discussion from Collector. Media files are removed unless another post uses them.</p><p>It will stay excluded from future refreshes, history fetching and archive imports, even after clearing collected data. Deletion applies only to your local library.</p><div className="dialog-actions"><button className="button" disabled={busy} onClick={()=>setPostToDelete(null)}>Keep post</button><button className="button danger" disabled={busy} onClick={()=>{const id=postToDelete.id;void action('delete-post',{id,confirm:true}).then(result=>{if(result){if(threadId.current===id){setThread(null);threadId.current=null;}setPostToDelete(null);}});}}>Delete post</button></div>{error&&<p className="notice error" role="alert">{error}</p>}</Modal>}
    {clearFeed&&<Modal title={'Clear all data for r/'+clearFeed+'?'} close={()=>setClearFeed(null)}><p>This stops syncing r/{clearFeed} and permanently deletes its posts, discussions, saved media and history checkpoints. Your subscription and history limit stay in place. Locally deleted posts stay excluded.</p><p>Other subreddits keep their data. Media files shared with another subreddit are kept. You can refresh this feed to collect it again.</p><div className="dialog-actions"><button className="button" disabled={busy} onClick={()=>setClearFeed(null)}>Keep data</button><button className="button danger" disabled={busy} onClick={()=>{const name=clearFeed;void action('clear-source',{name,confirm:true}).then(result=>{if(result){if(thread?.post.subreddit===name){setThread(null);threadId.current=null;}setClearFeed(null);}});}}>Clear data</button></div>{error&&<p className="notice error" role="alert">{error}</p>}</Modal>}
    {modal&&<Modal title={modal==='source'?'Add feed':modal==='history'?'Collection history':modal==='import'?'Import archive':modal==='settings'?'Settings':modal==='storage'?'Storage':'Clear content?'} close={()=>{if(!busy)setModal(null);}} wide={modal==='history'||modal==='storage'}>
      {modal==='storage'&&<StorageSettings token={token.current} setBusy={setBusy} changed={async()=>{await loadState();setReadBefore(Date.now());}}/>}
      {modal==='settings'&&<><form onSubmit={e=>{e.preventDefault();void action('settings',{maxStoredBytes:Math.round(Number(storageGb)*GB)}).then(result=>{if(result)setStorageSaved(true);});}}>
        <label>Max stored size (GB)<input type="number" min="0.001" max="10000" step="0.001" required value={storageGb} onChange={e=>{setStorageGb(e.target.value);setStorageSaved(false);}}/></label>
        <p className="muted">{storedSize(state?.storage.usedBytes??0)} stored. Includes the database and saved media. Browser profile and temporary files are excluded.</p>
        <p className="muted">Sync and imports pause at the cap. Lowering it keeps existing content. Raise it, then Resume to continue saving.</p>
        <div className="settings-save"><button className="button primary" disabled={busy||!state}>Save cap</button>{storageSaved&&<span role="status">Saved</span>}</div>
      </form><p><button className="button" disabled={busy} onClick={()=>{setError('');setModal('storage');}}>Manage storage</button></p><BackupSettings token={token.current} setBusy={setBusy} changed={async(replaced)=>{await loadState();if(!replaced)return;setSource('');setMedia('');setSearch('');setSearchScope('both');setReadFilter('all');setReadBefore(Date.now());setThread(null);threadId.current=null;}}/><div className="settings-account"><p>{state?.account?'Signed in as '+state.account:'Account verified on collection'}</p><button className="button" disabled={busy} onClick={()=>void action(state?.job.manual?'sign-in/finish':'sign-in')}>{state?.job.manual?'Finish sign-in':'Open sign-in browser'}</button><button className="button danger" disabled={busy} onClick={()=>{setError('');setModal('clear');}}>Clear collected content</button></div>{state?.canQuit&&<div className="settings-account"><p>Quit stops collection and preserves saved files and checkpoints.</p><button className="button" disabled={busy} onClick={()=>void quit()}>Quit app</button></div>}</>}
      {modal==='source'&&<form onSubmit={e=>{e.preventDefault();void action('sources',{name,historyMonths:months}).then(result=>{if(result){setModal(null);setName('');}});}}>
        <label>Subreddit<input required placeholder="e.g. python or r/aww" value={name} onChange={e=>setName(e.target.value)}/></label><label>History limit<select value={months} onChange={e=>setMonths(Number(e.target.value) as HistoryMonths)}>{HISTORY_OPTIONS.map(option=><option key={option.months} value={option.months}>{option.label}</option>)}</select></label>
        <p className="muted">Saves recent posts, history and supported media locally, up to 60 minutes and 120 requests per session. Stop anytime and Resume from saved progress.</p><button className="button primary" disabled={busy}>Add &amp; sync</button>
      </form>}
      {modal==='history'&&<><p className="muted">Saved page checkpoints are diagnostic history. Use Sync or Resume on Feeds to collect posts and save their media together. A finished page scan alone does not mean the feed is saved offline.</p>
        {state?.targets.map(target=><article className="history-item" key={target.id}><div><strong>r/{target.subreddit}</strong><span className="badge">{target.status==='done'?'Scan finished':target.status}</span><p>{target.lowerMs===null?'As far back as available':'Since '+date(target.lowerMs)} · {target.observedCount} encountered · {target.omissionCount} omitted</p>{target.oldestMs&&<p>Oldest: {timestamp(target.oldestMs)}</p>}<p className="muted">{target.reason??'Waiting'}{target.continuation?' · Checkpoint saved':''}</p></div></article>)}{!state?.targets.length&&<p>No collection history yet.</p>}</>}
      {modal==='import'&&<>
        <div className="archive-tabs" role="group" aria-label="Archive source"><button aria-pressed={archiveMode==='fetch'} onClick={()=>setArchiveMode('fetch')}>Fetch from archive</button><button aria-pressed={archiveMode==='file'} onClick={()=>setArchiveMode('file')}>Import a file</button></div>
        {archiveMode==='fetch'&&<form onSubmit={e=>{e.preventDefault();void action('archive/start',{subreddit:archiveName,from:archiveFrom,to:archiveTo});}}>
          <label>Subreddit<input required list="archive-subreddits" placeholder="e.g. python or r/aww" value={archiveName} onChange={e=>setArchiveName(e.target.value)}/><datalist id="archive-subreddits">{state?.sources.map(item=><option key={item} value={item}/>)}</datalist></label>
          <div className="archive-dates"><label>From (optional)<input type="date" value={archiveFrom} max={archiveTo||undefined} onInput={e=>setArchiveFrom(e.currentTarget.value)}/></label><label>To<input type="date" required value={archiveTo} min={archiveFrom||undefined} max={new Date().toISOString().slice(0,10)} onInput={e=>setArchiveTo(e.currentTarget.value)}/></label></div>
          <p className="muted">Dates include the whole day in UTC. Leave From blank for all available history. New subreddits are added to your feeds.</p>
          <button type="button" className="archive-all-time" onClick={()=>setArchiveFrom('')}>Use all available history</button>
          <p className="muted">Downloads posts from <a href="https://arctic-shift.photon-reddit.com" target="_blank" rel="noreferrer">Arctic Shift</a> and saves supported media for offline reading. Random 4–6 second gaps between requests; you can stop and resume. Archives and older media may have gaps.</p>
          <button className="button primary" disabled={busy||Boolean(archiveActive)||importBusy||state?.import?.state==='running'}>Fetch archive</button>
        </form>}
        {archiveMode==='file'&&<><p className="muted">Import an existing JSONL / NDJSON export, including .zst. Files are streamed in batches and pause at your storage cap.</p><label>Community<select value={importSource||state?.sources[0]||''} onChange={e=>setImportSource(e.target.value)}>{state?.sources.map(item=><option key={item}>{item}</option>)}</select></label><label>Comment post IDs (optional)<input placeholder="e.g. t3_abc, t3_def" value={importPostIds} onChange={e=>setImportPostIds(e.target.value)}/></label><p className="muted">For comment archives, enter up to 10 post IDs from Reddit links. Import their posts first. Leave blank for post archives.</p><label>Archive file<input type="file" accept=".jsonl,.ndjson,.zst" onChange={e=>setUpload(e.target.files?.[0]??null)}/></label>
        <p className="muted">Reimport the same file from the beginning to resume; earlier observations are reused.</p><button className="button primary" disabled={!upload||!feeds.length||importBusy||Boolean(archiveActive)} onClick={()=>void importFile()}>{importBusy?'Importing…':'Import file'}</button>{importBusy&&<button className="button stop" onClick={()=>void action('import/stop')}>Stop import</button>}{state?.import&&<div className="sample-note">{state.import.state} · {state.import.lines.toLocaleString()} lines · {state.import.accepted.toLocaleString()} accepted · {state.import.omitted} omitted<p>{state.import.reason}</p></div>}</>}
        {Boolean(state?.archives.length)&&<section className="archive-progress" aria-label="Archive fetches"><h3>Archive fetches</h3>{state!.archives.map(job=><article className="archive-job" key={job.id}>
          <div className="archive-job-heading"><strong>r/{job.subreddit}</strong><span className="badge">{job.state==='running'?(job.phase==='media'?'Saving media':'Fetching'):job.state==='done'?'Finished':'Paused'}</span></div>
          <p>{job.afterMs?new Date(job.afterMs).toISOString().slice(0,10):'All available history'} → {new Date(job.beforeMs-1).toISOString().slice(0,10)}</p>
          <p>{job.observed.toLocaleString()} posts checked · {job.added.toLocaleString()} new · {job.pages.toLocaleString()} pages{job.omitted>0?` · ${job.omitted} omitted`:''}{job.excluded>0?` · ${job.excluded} excluded`:''}</p>
          {job.oldestMs!==null&&<p>Oldest saved: {timestamp(job.oldestMs)}</p>}
          {job.offline.total>0&&<p>Media {job.offline.ready}/{job.offline.total} offline{job.offline.failed?` · ${job.offline.failed} failed`:''}{job.offline.unavailable?` · ${job.offline.unavailable} unavailable`:''}</p>}
          {job.reason&&<p className="archive-reason">{job.reason}</p>}{job.notBefore&&job.notBefore>Date.now()&&<p>Retry after {timestamp(job.notBefore)}</p>}
          <div className="archive-job-actions">{job.state==='running'?<button className="button stop" disabled={busy} onClick={()=>void action('archive/stop',{id:job.id})}>Stop archive</button>:job.state==='paused'?<button className="button" disabled={busy||Boolean(archiveActive)||Boolean(job.notBefore&&job.notBefore>Date.now())} onClick={()=>void action('archive/resume',{id:job.id})}>Resume archive</button>:null}</div>
        </article>)}</section>}
      </>}
      {modal==='clear'&&<><p>Deletes collected posts, discussions and history checkpoints, and stops active work. Your feeds and browser sign-in remain. The next sync verifies the current browser account again. Locally deleted posts stay excluded.</p><button className="button danger" disabled={busy} onClick={()=>void action('clear').then(result=>{if(result){setThread(null);threadId.current=null;setModal(null);}})}>Clear content</button></>}
      {error&&<p className="notice error" role="alert">{error}</p>}
    </Modal>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
