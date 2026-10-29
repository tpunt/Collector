import { randomUUID } from 'node:crypto';
import { ReaderBrowser, AccessError } from './browser.ts';
import { readListing, readThread, collectClassicListingDom } from './extract.ts';
import { advanceBoundary } from './history.ts';
import type { ReaderStore,HistoryTarget,StoredPost } from './store.ts';
import {postId} from './domain.ts';
import {feedName,feedIdentity,listingUrl,tumblrPostUrl,tumblrSearchUrl,hasExternalAttachment,externalAttachmentNote} from './sources.ts';
import type {Platform} from './sources.ts';
import type { Page } from 'playwright';
import type { RequestQueue } from './request-gate.ts';
import { discoverMedia } from './media-discovery.ts';
import { SyncLimitError, UnsupportedMediaError, PostUnavailableError,PostIdentityError,ExtractionError } from './sync-errors.ts';
import {readTumblrListing,readTumblrPost,readTumblrSearch} from './tumblr.ts';
import {newTumblrHistory,tumblrHistoryCheckpoint,planTumblrWindow,captureTumblrWindow,finishTumblrWindow,tumblrCheckpointUrl,tumblrHistoryReason} from './tumblr-history.ts';
import type {TumblrHistoryCheckpoint} from './tumblr-history.ts';
import type {CollectionReports} from './collection-report.ts';
import type {ProblemContext,ProblemReporter} from './problems.ts';
import {StorageLimitError} from './storage-limit.ts';
import { setTimeout as delay } from 'node:timers/promises';
import {emptySignInStatus} from './sign-in.ts';
import type {SignInObservation,SignInStatus} from './sign-in.ts';

export interface MediaSyncDriver {
  readonly status:{requests:number;requestsBySource?:{reddit:number;tumblr:number}};
  pendingPosts(source:string,session:string):string[];
  preparePost(id:string,session:string):{discover:boolean}|null;
  syncPost(id:string,session:string,allowance:number,signal:AbortSignal):Promise<void>;
  stop(source?:string):void;
  stopPost?(id:string):void;
  reconcile?():Promise<void>;
}
export type PausedTask={kind:'media-source'|'body-source';subreddit:string}|{kind:'thread'|'media'|'body';postId:string};
type Work = ({ id: string; kind: 'target'; targetId: string; head: boolean; deadline: number; generation: number } |
  { id: string; kind: 'thread' | 'media' | 'body'; postId: string; deadline: number; generation: number } |
  {id:string;kind:'media-source'|'body-source';subreddit:string;deadline:number;generation:number}) & {requestBaseline?:number};
export interface JobDependencies {
  reports?:CollectionReports;
  problems?:ProblemReporter;
  network?: RequestQueue;
  mediaSync?:MediaSyncDriver|null;
  onPause?: () => void;
  browser?: Pick<ReaderBrowser, 'counts' | 'open' | 'navigate' | 'close' | 'manualSignIn'> & {mediaCandidates?:string[]};
  discoverMedia?: typeof discoverMedia;
  readListing?: typeof readListing;
  readThread?: typeof readThread;
  readAccount?: (page: Page) => Promise<string | null>;
  readTumblrSearch?:typeof readTumblrSearch;
}
export class ReaderJobs {
  private store: ReaderStore;
  private browser: NonNullable<JobDependencies['browser']>;
  private listing: typeof readListing;
  private discussion: typeof readThread;
  private account: NonNullable<JobDependencies['readAccount']>;
  private tumblrSearch:typeof readTumblrSearch;
  private queue: Work[] = [];
  private active: Work | null = null;
  private controller: AbortController | null = null;
  private pumping = false;
  private pumpDone:Promise<void>|null=null;
  private mediaSync:MediaSyncDriver|null;
  private session='';
  private stopping = false;
  private manual = false;
  private manualPlatform:Platform='reddit';
  private signInRevision=0;
  private signInStatus:Record<Platform,SignInStatus>={reddit:emptySignInStatus(),tumblr:emptySignInStatus()};
  private stoppedWork = new Set<string>();
  private browserOpen = false;
  private mediaMode = false;
  private browserPlatform:'reddit'|'tumblr'|null=null;
  private closing: Promise<void> | null = null;
  private completedRequests = 0;
  private completedRedditRequests = 0;
  private archiveRequestBaseline:number|null=null;
  private feedRuns=new Map<string,string>();
  private reportRuns=new Map<string,string>();
  private message = 'Ready';
  private onPause: () => void;
  private discover: typeof discoverMedia;
  private attemptedBodies=new Set<string>();
  private network:RequestQueue|undefined;
  private signingIn:Promise<void>|null=null;
  private reported=new WeakSet<Error>();
  private problems:ProblemReporter;
  private pageUrl:string|null=null;
  private reports:CollectionReports|undefined;
  private retryRuns=new Map<string,string>();
  private retryReasons=new Map<string,string>();
  constructor(store: ReaderStore, dependencies: JobDependencies = {}) {
    this.reports=dependencies.reports;this.network=dependencies.network;this.problems=dependencies.problems??(()=>{});
    this.store = store;this.mediaSync=dependencies.mediaSync??null;
    this.onPause = dependencies.onPause ?? (() => {});
    this.discover = dependencies.discoverMedia ?? discoverMedia;
    this.browser = dependencies.browser ?? new ReaderBrowser(error => {
      this.accessFailure(error);
    }, dependencies.network);
    this.listing = dependencies.readListing ?? readListing;
    this.discussion = dependencies.readThread ?? readThread;
    this.account = dependencies.readAccount ?? (async page => (await page.evaluate(collectClassicListingDom)).account);
    this.tumblrSearch=dependencies.readTumblrSearch??readTumblrSearch;
  }
  private problem(error:unknown,extra:Partial<ProblemContext>={}){
    if(error instanceof Error){if(this.reported.has(error))return;this.reported.add(error);}
    const work=this.active,feed=work?this.sourceOf(work):null;
    this.problems({operation:work?.kind==='target'?'listing':work?.kind==='media'?'download':work?.kind==='thread'?'discussion':work?.kind==='body'?'body':this.manual?'sign-in':'collection',feed,post:work&&'postId'in work?work.postId:null,checkpoint:work?.kind==='target'?work.targetId:null,url:this.pageUrl,...extra},error);
  }
  private sourceOf(work: Work): string | null {
    if('subreddit' in work)return work.subreddit;
    return work.kind === 'target' ? this.store.getTarget(work.targetId)?.subreddit ?? null : this.store.getPost(work.postId)?.subreddit ?? null;
  }
  feedStatus(input: string): 'idle' | 'queued' | 'syncing' | 'stopping' {
    const name = feedName(input);
    if (this.active && this.sourceOf(this.active) === name) return this.stopping || this.stoppedWork.has(this.active.id) ? 'stopping' : 'syncing';
    return this.queue.some(work => this.sourceOf(work) === name) ? 'queued' : 'idle';
  }
  hasTarget(id:string):boolean{return (this.active?.kind==='target'&&this.active.targetId===id)||this.queue.some(work=>work.kind==='target'&&work.targetId===id);}
  get state() { return { running: this.pumping || this.manual, manual: this.manual, manualPlatform:this.manual?this.manualPlatform:null, queued: this.queue.length, active: this.manual ? 'sign-in' : this.active?.kind ?? null,
    subreddit: this.active ? this.sourceOf(this.active) : null, signIn:structuredClone(this.signInStatus),
    message: this.message, requests: { ...this.browser.counts, sessionTotal: this.completedRequests + (this.browserOpen ? this.browser.counts.released : 0) },
    sourcePause:this.store.getSetting<{reason:string;notBefore:number|null}>('accessPause:tumblr'),
    accessPause: this.store.getSetting<{reason: string; notBefore: number | null}>('accessPause') }; }
  private allowed(explicitResume: boolean) {
    this.network?.assertOnline();
    if (this.manual) throw new Error('Close the sign-in browser before collecting');
    if (this.stopping && this.pumping) throw new Error('The previous operation is stopping. Try again when it has closed.');
    const pause = this.store.getSetting<{reason: string; notBefore: number | null}>('accessPause');
    if (pause) {
      if (!explicitResume) throw new Error(`${pause.reason}. Use Resume to revalidate access explicitly.`);
      if (pause.notBefore && pause.notBefore > Date.now()) throw new Error(`Cooldown lasts until ${new Date(pause.notBefore).toLocaleString()}`);
      this.store.setSetting('accessPause', null);
    }
  }
  private sourceAllowed(name:string,resume=false){
    if(feedIdentity(name).platform!=='tumblr')return;
    this.tumblrAllowed(resume);
  }
  private tumblrAllowed(resume=false,checkOnly=false){
    const pause=this.store.getSetting<{reason:string;notBefore:number|null}>('accessPause:tumblr');if(!pause)return;
    if(!resume||pause.notBefore&&pause.notBefore>Date.now())throw new AccessError(pause.reason+(pause.notBefore?` · Cooldown until ${new Date(pause.notBefore).toLocaleString()}`:''),pause.notBefore,'tumblr');
    if(!checkOnly)this.store.setSetting('accessPause:tumblr',null);
  }
  private selectSources(names:string[]){
    const mixed=new Set(names.map(name=>feedIdentity(name).platform)).size>1;
    return names.filter(name=>{if(mixed&&feedIdentity(name).platform==='tumblr'&&this.store.getSetting('accessPause:tumblr'))return false;this.sourceAllowed(name,true);return true;});
  }
  private beginReport(name:string,kind:'sync'|'retry'){
    const id=this.reports?.begin(name,kind);if(id)this.reportRuns.set(name,id);
  }
  attachMedia(media:MediaSyncDriver|null){this.mediaSync=media;}
  /** Capture only work in flight/queued now, never older manually paused scans. */
  offlineWork(){
    if(this.stopping)return{feeds:[],tasks:[],signIn:false};
    const work=[...this.queue,...(this.active?[this.active]:[])].filter(item=>!this.stoppedWork.has(item.id));
    const feeds=[...new Set([...this.feedRuns.keys()].filter(name=>work.some(item=>this.sourceOf(item)===name)).concat(work.filter(item=>item.kind==='target').map(item=>this.sourceOf(item)).filter((name):name is string=>Boolean(name))))];
    const tasks:PausedTask[]=work.flatMap<PausedTask>(item=>item.kind==='target'||item.kind!=='thread'&&feeds.includes(this.sourceOf(item)??'')?[]:'postId'in item?[{kind:item.kind,postId:item.postId}]:[{kind:item.kind,subreddit:item.subreddit}]);
    return{feeds,tasks,signIn:this.manual,...this.manual&&this.manualPlatform==='tumblr'?{signInPlatform:'tumblr' as const}:{}};
  }
  resumeOfflineTasks(tasks:PausedTask[]){
    this.assertCanQueue();this.stopping=false;const deadline=Date.now()+60*60_000;
    for(const task of tasks)if(task.kind==='media-source'&&'subreddit'in task&&this.store.followedSources().includes(task.subreddit)){this.beginReport(task.subreddit,'retry');this.retryRuns.set(task.subreddit,randomUUID());this.retryReasons.delete(task.subreddit);}
    for(const task of tasks){
      if('subreddit'in task){if(!this.store.followedSources().includes(task.subreddit))continue;}
      else{const post=this.store.getPost(task.postId);if(!post||task.kind!=='thread'&&!this.store.followedSources().includes(post.subreddit))continue;}
      this.queue.push({...task,id:randomUUID(),deadline,generation:this.store.generation});
    }
    this.start();
  }
  private redditRequests(){return this.completedRedditRequests+(this.browserOpen&&this.browserPlatform==='reddit'?this.browser.counts.released:0)+(this.mediaSync?.status.requestsBySource?.reddit??this.mediaSync?.status.requests??0);}
  private queueMediaSource(name:string,deadline:number){
    if(!this.mediaSync||this.queue.some(work=>work.kind==='media-source'&&work.subreddit===name))return;
    this.queue.push({id:randomUUID(),kind:'media-source',subreddit:name,deadline,generation:this.store.generation});
  }
  private queueBodies(name:string,deadline:number,requestBaseline?:number){
    if(!this.queue.some(work=>work.kind==='body-source'&&work.subreddit===name))this.queue.push({id:randomUUID(),kind:'body-source',subreddit:name,deadline,generation:this.store.generation,requestBaseline});
  }
  syncMedia(names:string[],options:{resume?:boolean}={}){
    this.store.assertStorageAvailable();
    this.allowed(Boolean(options.resume));this.stopping=false;
    for(const name of names)if(this.store.followedSources().includes(feedName(name)))this.queueMediaSource(feedName(name),Date.now()+60*60_000);
    this.start();
  }
  assertCanQueue(resume=false,source?:string) { this.store.assertStorageAvailable();this.allowed(resume);if(source&&feedIdentity(source).platform==='tumblr')this.tumblrAllowed(resume,true); }
  /** One explicit operation owns listing catch-up, historical pages and offline files. */
  syncFeeds(inputs:string[],plan?:{heads:string[];history:string[]}) {
    this.assertCanQueue(true);
    const selectedNames=this.selectSources([...new Set(inputs.map(feedName))]);
    if(selectedNames.some(name=>!this.store.followedSources().includes(name)))throw new Error('Sync requires a subscribed feed');
    // History changes stop the previous run first. Its aborted page may still be
    // unwinding; an explicit replacement plan must queue behind it, not vanish.
    const names=selectedNames.filter(name=>this.feedStatus(name)==='idle'||Boolean(plan&&this.active&&
      this.sourceOf(this.active)===name&&this.stoppedWork.has(this.active.id)));
    const plans=names.map(name=>{
      const resume=plan?null:this.store.resumeSyncPlan(name);
      const selected=plan?{heads:plan.heads.filter(id=>this.store.getTarget(id)?.subreddit===name),history:plan.history.filter(id=>this.store.getTarget(id)?.subreddit===name)}:
        resume??this.store.planSync([name]);
      const goal=this.store.ensureHistoryTarget(name);
      const ids=[...new Set([...selected.heads,...selected.history,goal])];
      this.beginReport(name,'sync');
      const run=this.store.beginFeedSync(name,ids);this.feedRuns.set(name,run);
      return selected;
    });
    try{
      this.targets(plans.flatMap(plan=>plan.heads),{heads:true,resume:true});
      this.targets(plans.flatMap(plan=>plan.history),{resume:true});
      this.syncMedia(names,{resume:true});
      for(const name of names)this.queueBodies(name,Date.now()+60*60_000);
      this.start();
      this.finishFeeds();
    }catch(error){const reason=error instanceof Error?error.message:'Sync could not start';for(const name of names){void this.stopSource(name,reason).catch(error=>this.problem(error,{operation:'browser-close'}));this.reports?.finish(name,'paused',reason,this.reportRuns.get(name));this.reportRuns.delete(name);this.feedRuns.delete(name);}throw error;}
    return plans.reduce((sum,plan)=>sum+plan.heads.length+plan.history.length,0);
  }
  retryMedia(names:string[]){
    this.assertCanQueue(true);
    const selected=this.selectSources([...new Set(names.map(feedName))]);
    if(!selected.length||selected.some(name=>!this.store.followedSources().includes(name)))throw new Error('Choose subscribed feeds to retry');
    if(selected.some(name=>this.feedStatus(name)!=='idle'))throw new Error('Wait for this feed to finish before retrying downloads');
    for(const name of selected){this.beginReport(name,'retry');this.retryRuns.set(name,randomUUID());this.retryReasons.delete(name);}
    this.syncMedia(selected,{resume:true});this.finishFeeds();
  }
  private finishFeeds(){
    for(const [name,id] of this.feedRuns){
      if(this.active&&this.sourceOf(this.active)===name||this.queue.some(work=>this.sourceOf(work)===name))continue;
      this.store.finishFeedSync(name,id);this.feedRuns.delete(name);
      const summary=this.store.feedSync(name);this.reports?.finish(name,summary.state==='incomplete'?'paused':'finished',summary.reason,this.reportRuns.get(name));this.reportRuns.delete(name);
    }
    for(const [name] of this.retryRuns){
      if(this.active&&this.sourceOf(this.active)===name||this.queue.some(work=>this.sourceOf(work)===name))continue;
      this.store.settleMediaRetry(name);
      const counts=this.store.offlineMedia(name),pending=counts.pending+counts.failed;
      const reason=this.store.getSetting<{reason:string}>('accessPause')?.reason??this.retryReasons.get(name)??(pending?`${pending} media posts still need saving`:null);
      this.reports?.finish(name,pending||reason?'paused':'finished',reason,this.reportRuns.get(name));this.reportRuns.delete(name);this.retryRuns.delete(name);this.retryReasons.delete(name);
    }
  }
  /** Only an explicit archive Start/Resume resets its browser/CDN allowance. */
  beginArchiveRun() {this.archiveRequestBaseline=this.redditRequests();}
  /** Save just this committed archive page before the fetcher advances. */
  async archiveMedia(ids:string[],signal:AbortSignal) {
    signal.throwIfAborted();
    this.assertCanQueue();this.stopping=false;
    await this.mediaSync?.reconcile?.();signal.throwIfAborted();
    const matches=(work:Work)=>(work.kind==='media'||work.kind==='body')&&ids.includes(work.postId);
    for(const id of ids){const state=this.store.bodySync(id);if(state&&state.status!=='ready'&&!this.queue.some(work=>work.kind==='body'&&work.postId===id))this.queue.push({id:randomUUID(),kind:'body',postId:id,deadline:Date.now()+60*60_000,generation:this.store.generation,requestBaseline:this.archiveRequestBaseline??undefined});}
    for(const id of ids)if(this.store.mediaSync(id)&&!this.queue.some(work=>work.kind==='media'&&work.postId===id)&&!(this.active?.kind==='media'&&this.active.postId===id))
      this.queue.push({id:randomUUID(),kind:'media',postId:id,deadline:Date.now()+60*60_000,generation:this.store.generation,requestBaseline:this.archiveRequestBaseline??undefined});
    this.start();
    while(this.queue.some(matches)||(this.active&&matches(this.active))){await delay(50,undefined,{signal});}
    signal.throwIfAborted();
    const pause=this.store.getSetting<{reason:string}>('accessPause');if(pause)throw new Error(pause.reason);
    const missing=ids.filter(id=>{const state=this.store.mediaSync(id);return state&&['pending','downloading','failed'].includes(state.status);});
    const missingBodies=ids.filter(id=>{const state=this.store.bodySync(id);return state&&state.status!=='ready';});
    if(missingBodies.length)throw new Error(`${missingBodies.length} archive post bodies could not be saved; Resume archive to retry`);
    if(missing.length)throw new Error(`${missing.length} archive media post(s) could not be saved; Resume archive to retry`);
  }
  targets(ids: string[], options: { resume?: boolean; heads?: boolean } = {}) {
    this.store.assertStorageAvailable();
    this.allowed(Boolean(options.resume));
    this.stopping = false;
    const deadline = Date.now() + 60 * 60_000;
    for (const id of ids) {
      const target = this.store.getTarget(id);
      if (!target || ['done', 'cancelled'].includes(target.status) || !this.store.followedSources().includes(target.subreddit)) continue;
      if (this.queue.some(work => work.kind === 'target' && work.targetId === id) || (this.active?.kind === 'target' && this.active.targetId === id)) continue;
      if(target.dependsOn){const prerequisite=this.store.getTarget(target.dependsOn);
        if(!prerequisite||prerequisite.status==='cancelled')throw new Error('Newer catch-up was cancelled; Sync this feed to plan it again');
        if(prerequisite.status!=='done')this.targets([prerequisite.id],{...options,heads:true});
      }
      this.queue.push({ id: randomUUID(), kind: 'target', targetId: id, head: options.heads ?? false, deadline, generation: this.store.generation });
      this.queueMediaSource(target.subreddit,deadline);
    }
    this.start();
  }
  thread(postId: string) {
    this.store.assertStorageAvailable();
    this.allowed(false); this.stopping = false;
    if (!this.store.getPost(postId)) throw new Error('Post not found');
    if(feedIdentity(this.store.getPost(postId)!.subreddit).platform==='tumblr')throw new Error('Tumblr replies are not collected; the full saved post is available locally');
    if (this.queue.some(item => item.kind === 'thread' && item.postId === postId) || (this.active?.kind === 'thread' && this.active.postId === postId)) return;
    this.queue.unshift({ id: randomUUID(), kind: 'thread', postId, deadline: Date.now() + 3 * 60_000, generation: this.store.generation });
    this.start();
  }
  private async openBrowser(remaining:number,mode:false|'media'|'tumblr'){
    const platform=mode==='tumblr'?'tumblr':'reddit',media=mode==='media';
    // Count the previous profile's requests before ReaderBrowser opens another
    // platform or mode; its underlying counter resets when the context changes.
    if(this.browserOpen&&(this.browserPlatform!==platform||this.mediaMode!==media))await this.closeBrowser();
    // Long Tumblr history runs keep going at the Tumblr source rate, rotating bounded
    // browser contexts between tasks. Access failures never auto-retry.
    if(mode==='tumblr'&&this.browserOpen&&this.browser.counts.released>=200)await this.closeBrowser();
    await this.browser.open(mode==='tumblr'?1000:remaining,mode);this.browserOpen=true;this.browserPlatform=platform;this.mediaMode=media;
  }
  private async closeBrowser() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.browser.close();
      if (this.browserOpen) { this.completedRequests += this.browser.counts.released;if(this.browserPlatform==='reddit')this.completedRedditRequests+=this.browser.counts.released;this.browserOpen = false;this.browserPlatform=null; }
    })();
    try { await this.closing; } finally { this.closing = null; }
  }
  pause(reason = 'Stopped by user') {
    if(this.manual){const status=this.signInStatus[this.manualPlatform];if(status.state==='checking'||status.state==='waiting')this.signInStatus[this.manualPlatform]={...status,state:'unverified'};}
    this.signInRevision++;
    this.onPause();this.mediaSync?.stop();
    this.stopping = true;
    this.controller?.abort();
    const sources = new Set([...this.queue, ...(this.active ? [this.active] : [])].map(work => this.sourceOf(work)).filter((name): name is string => Boolean(name)));
    for (const name of sources){this.store.pauseSource(name, reason);if(this.retryRuns.has(name))this.retryReasons.set(name,reason);}
    this.queue = []; this.message = reason;this.finishFeeds();
    this.manual = false;
    void this.closeBrowser().catch(error=>this.problem(error,{operation:'browser-close'}));
  }
  accessFailure(error: AccessError,log=true) {
    if(log)this.problem(error);
    const platform=error.platform??(this.manual?this.manualPlatform:'reddit');
    if(this.manual||/sign.in|account/i.test(error.message))this.signInStatus[platform]={...this.signInStatus[platform],state:'error'};
    if(error.platform==='tumblr'){
      this.store.setSetting('accessPause:tumblr',{reason:error.message,notBefore:error.notBefore});
      if(this.manual&&this.manualPlatform==='tumblr')this.pause(error.message);
      for(const name of this.store.followedSources().filter(name=>feedIdentity(name).platform==='tumblr'&&(this.feedStatus(name)!=='idle'||this.feedRuns.has(name)||this.retryRuns.has(name))))void this.stopSource(name,error.message).catch(error=>this.problem(error,{operation:'browser-close'}));
      return;
    }
    this.store.setSetting('accessPause', { reason: error.message, notBefore: error.notBefore });
    this.pause(error.message);
  }
  async stopSource(input: string, reason = 'Stopped by user') {
    const name = feedName(input);if(this.retryRuns.has(name))this.retryReasons.set(name,reason);this.mediaSync?.stop(name);
    this.queue = this.queue.filter(work => this.sourceOf(work) !== name);
    this.store.pauseSource(name, reason);
    if (this.active && this.sourceOf(this.active) === name) {
      this.stoppedWork.add(this.active.id);
      this.controller?.abort();
      await this.closeBrowser();
    }
    this.finishFeeds();this.message = `${feedIdentity(name).label}: ${reason.toLowerCase()}`;
  }
  async stopPost(input:string) {
    const id=postId(input);this.mediaSync?.stopPost?.(id);
    const matches=(work:Work)=>['thread','media','body'].includes(work.kind)&&'postId' in work&&work.postId===id;
    this.queue=this.queue.filter(work=>!matches(work));
    if(this.active&&matches(this.active)){
      this.stoppedWork.add(this.active.id);this.controller?.abort();await this.closeBrowser();
    }
  }
  async signIn(platform:Platform='reddit') {
    if(platform!=='reddit'&&platform!=='tumblr')throw new Error('Choose Reddit or Tumblr sign-in');
    if(this.closing)await this.closing;
    if (this.pumping) throw new Error('Stop collection and wait for the browser to close first');
    if(this.manual)throw new Error('Close the sign-in browser before opening another');
    if(platform==='tumblr')this.tumblrAllowed(true,true);
    this.allowed(true);if(platform==='tumblr')this.tumblrAllowed(true);
    this.stopping=false;this.manual = true;this.manualPlatform=platform;this.browserPlatform=platform;this.browserOpen = true;
    const revision=++this.signInRevision;
    this.signInStatus[platform]={...this.signInStatus[platform],state:'checking',detail:undefined};
    this.pageUrl=platform==='tumblr'?'https://www.tumblr.com/login':'https://www.reddit.com/login/';
    this.message = `Checking ${platform==='tumblr'?'Tumblr':'Reddit'} sign-in. Complete sign-in in Chrome if requested; Collector closes the window after confirmation.`;
    const opening=this.browser.manualSignIn(platform,observation=>this.observeSignIn(platform,revision,observation));
    this.signingIn=opening;
    try { await opening; }
    catch (error) {
      if(this.manual&&revision===this.signInRevision){
        this.signInStatus[platform]={...this.signInStatus[platform],state:'error'};
        this.problem(error,{operation:'sign-in'});this.pause(error instanceof Error ? error.message : 'Sign-in failed');throw error;
      }
      if(this.signInStatus[platform].state==='error')throw error;
    }
    finally{if(this.signingIn===opening)this.signingIn=null;}
  }
  private verifyRedditAccount(account:string){
    this.store.bindAccount(account);
    this.signInStatus.reddit={state:'signed-in',account,verifiedAt:Date.now()};
  }
  private observeSignIn(platform:Platform,revision:number,observation:SignInObservation){
    if(!this.manual||this.manualPlatform!==platform||revision!==this.signInRevision)return;
    if(observation.state==='signed-in'){
      this.signInStatus[platform]={state:'signed-in',account:observation.account,verifiedAt:Date.now()};
      this.pause(`${platform==='tumblr'?'Tumblr':'Reddit'} signed in${observation.account?' as '+observation.account:''}. Session saved; ready to sync.`);
    }else if(observation.state==='signed-out')this.signInStatus[platform]={state:'waiting',account:null,verifiedAt:null};
    else if(observation.state==='form-error'){
      const detail='The website rejected the login form (Cannot POST /login). Reopen the sign-in browser and let the page finish loading.';
      this.signInStatus[platform]={...this.signInStatus[platform],state:'error',detail};
      const error=new AccessError(detail,null,platform);error.code='ERR_SIGN_IN_FORM_POST';this.accessFailure(error);
    }
    else if(observation.state==='closed')void this.finishSignIn().catch(error=>this.problem(error,{operation:'browser-close'}));
  }
  async finishSignIn() {if(!this.manual)throw new Error('No sign-in browser is open');this.pause('Sign-in browser closed without confirmation. Recheck the saved session before relying on it.'); await this.closeBrowser(); }
  async close(reason='Application stopped; explicit Resume required') { this.pause(reason); await this.closeBrowser();await this.pumpDone;await this.signingIn?.catch(()=>{});await this.closeBrowser(); }
  private tumblrUnavailableOptions(feed:string){const run=this.feedRuns.get(feed)??this.retryRuns.get(feed)??this.session;return{unavailableThisRun:(id:string)=>this.store.sourceUnavailableThisRun(feed,id,run),unavailable:(id:string)=>this.store.noteSourceUnavailable(feed,id,run)};}
  private async fetchTumblrPost(post:StoredPost,generation:number){
    try{
      const page=await this.browser.navigate(this.pageUrl=tumblrPostUrl(post.id),this.controller!.signal);
      return await readTumblrPost(page,post.id,url=>this.browser.navigate(this.pageUrl=url,this.controller!.signal),{epochMs:post.createdMs,precisionMs:post.precisionMs});
    }catch(error){
      this.controller!.signal.throwIfAborted();
      if(!(error instanceof PostUnavailableError))throw error;
      if(error.postId!==post.id)throw new PostIdentityError(post.id,[error.postId??null],this.pageUrl??post.permalink);
      this.tumblrUnavailableOptions(post.subreddit).unavailable(post.id);
      this.store.markPostUnavailable(generation,post.id,error.availability);await this.mediaSync?.reconcile?.();this.controller!.signal.throwIfAborted();
      this.store.noteSyncGap(post.subreddit);this.message='Tumblr post is unavailable; continuing older history';await this.closeBrowser();return null;
    }
  }
  private async tumblrHistoryStep(work:Extract<Work,{kind:'target'}>,target:HistoryTarget,state:TumblrHistoryCheckpoint){
    const save=(observations:Parameters<ReaderStore['commitBatch']>[0]['observations']=[],seenPostIds:string[]=[],omissions=0,unavailablePostIds:string[]=[])=>{
      this.controller!.signal.throwIfAborted();
      this.store.commitBatch({generation:work.generation,targetId:target.id,observations,seenPostIds,omissions,unavailablePostIds,continuation:tumblrCheckpointUrl(target.subreddit,state),boundary:{...target.boundary,source:state},status:'queued'});
    };
    if(state.active&&state.active.outcome!=='query'){
      let pending=false;
      for(const id of state.active.ids){
        if(this.store.isPostExcluded(id))continue;
        const post=this.store.getPost(id);if(!post)throw new Error('A saved Tumblr history post is missing; checkpoint retained');
        if(post.availability!=='available')continue;
        if(post.bodySync?.status==='failed')throw new Error('Tumblr post text failed to save; Resume retries it before advancing history');
        if(post.bodySync&&post.bodySync.status!=='ready')pending=true;
        const media=this.mediaSync?this.store.mediaSync(id):null;
        if(media?.status==='failed')throw new Error('Tumblr media failed to save; Resume retries it before advancing history');
        if(media&&['pending','downloading'].includes(media.status))pending=true;
      }
      if(pending){
        this.queueBodies(target.subreddit,work.deadline);this.queueMediaSource(target.subreddit,work.deadline);
        this.queue.push({...work,head:false});return;
      }
      this.reports?.releaseHistoryPage(target.subreddit,state.active.ids);
      for(const id of state.active.ids)this.attemptedBodies.delete(id);
      finishTumblrWindow(state);
    }
    const range=planTumblrWindow(state);
    if(!range){
      this.store.commitBatch({generation:work.generation,targetId:target.id,observations:[],continuation:null,boundary:{...target.boundary,source:state},status:'done',completion:'listing-end',reason:tumblrHistoryReason(state)});
      this.message=`${feedIdentity(target.subreddit).label}: dated history finished; ${state.unverified} windows unverified`;return;
    }
    save();
    const url=tumblrSearchUrl(target.subreddit,range.lower,range.upper);
    this.message=`Searching ${feedIdentity(target.subreddit).label} history · ${new Date(range.lower).toISOString().slice(0,10)} to ${new Date(range.upper).toISOString().slice(0,10)} · ${state.checked} windows checked`;
    await this.openBrowser(1000,'tumblr');
    const page=await this.browser.navigate(this.pageUrl=url,this.controller!.signal);
    const inside=(time:number)=>time>=(target.lowerMs??0)&&time<=target.upperMs;
    const result=await this.tumblrSearch(page,target.subreddit,{
      ...this.tumblrUnavailableOptions(target.subreddit),
      navigate:next=>this.browser.navigate(this.pageUrl=next,this.controller!.signal),
      knownDate:id=>{const post=this.store.getPost(id);return post?{epochMs:post.createdMs,precisionMs:post.precisionMs}:null;},
      knownUnavailable:id=>{const post=this.store.getPost(id);return Boolean(post&&post.availability!=='available');},
      excluded:id=>this.store.isPostExcluded(id),
      resolved:post=>{
        if(!inside(post.created.epochMs)||this.store.isPostExcluded(post.id))return;
        const before=this.store.getPost(post.id);save([post]);this.attemptedBodies.add(post.id);this.reports?.observe(target.subreddit,[before],[post.id]);
      }
    });
    this.controller!.signal.throwIfAborted();
    const candidates=result.posts.filter(post=>inside(post.created.epochMs)&&!this.store.isPostExcluded(post.id));
    const known:string[]=[],observations:typeof candidates=[];
    const before=candidates.map(post=>this.store.getPost(post.id));
    const firstSeen=candidates.map(post=>!this.store.hasTargetPost(target.id,post.id));
    candidates.forEach((post,index)=>{
      if(before[index]?.source==='live'&&before[index]!.availability==='available')known.push(post.id);
      else observations.push({...post,body:undefined,bodyNeedsFetch:true});
    });
    captureTumblrWindow(state,candidates.map(post=>post.id),result.potentiallyCapped,result.unverifiedEmpty);
    const missing=result.unavailableIds?.filter(id=>{const post=this.store.getPost(id);return !post||inside(post.createdMs);});
    save(observations,known,result.omissions,missing);
    const changed=candidates.map((post,index)=>({post,before:before[index],first:firstSeen[index]})).filter(item=>item.first||!item.before||item.before.source!=='live'||item.before.bodySync?.status!=='ready');
    this.reports?.observe(target.subreddit,changed.map(item=>item.before),changed.map(item=>item.post.id));
    this.queueBodies(target.subreddit,work.deadline);this.queueMediaSource(target.subreddit,work.deadline);
    this.queue.push({...work,head:false});
  }
  private start() { if (!this.pumping && this.queue.length) { this.pumping = true;this.session=randomUUID();this.attemptedBodies.clear();const done=this.pump();this.pumpDone=done;void done.catch(error=>this.problem(error,{operation:'collection'})).finally(()=>{if(this.pumpDone===done)this.pumpDone=null;}); } }
  private async pump() {
    const startingRequests = this.redditRequests();
    try {
      while (this.queue.length && !this.stopping) {
        const ready=(work:Work)=>work.kind!=='target'||!this.store.getTarget(work.targetId)?.dependsOn||this.store.getTarget(this.store.getTarget(work.targetId)!.dependsOn!)?.status==='done';
        const rank=(work:Work)=>work.kind==='thread'?0:work.kind==='target'&&work.head?1:work.kind==='media'||work.kind==='body'?2:work.kind==='media-source'||work.kind==='body-source'?3:4;
        let index=-1;
        for(let i=0;i<this.queue.length;i++)if(ready(this.queue[i]!)&&(index<0||rank(this.queue[i]!)<rank(this.queue[index]!)))index=i;
        if(index<0){for(const work of this.queue)if(work.kind==='target')this.store.pauseTarget(work.targetId,'Newer catch-up is unfinished; Resume to continue');this.queue=[];break;}
        const work = this.queue.splice(index, 1)[0]!;
        const workSession=this.feedRuns.get(this.sourceOf(work)??'')??this.retryRuns.get(this.sourceOf(work)??'')??this.session;
        this.active = work;this.pageUrl=null;
        this.controller = new AbortController();
        if (Date.now() >= work.deadline&&feedIdentity(this.sourceOf(work)??'unknown').platform!=='tumblr') {
          if (work.kind === 'target') this.store.pauseTarget(work.targetId, 'Session time budget reached; Resume to fetch more');
          continue;
        }
        try {
          if (this.closing) await this.closing;
          this.controller.signal.throwIfAborted();
          if(work.generation!==this.store.generation)continue;
          this.store.assertStorageAvailable();const workSource=this.sourceOf(work);if(workSource)this.sourceAllowed(workSource);
          if(work.kind==='body-source'){
            const ids=this.store.pendingBodies(work.subreddit,this.attemptedBodies);
            for(const postId of ids){this.attemptedBodies.add(postId);this.queue.push({id:randomUUID(),kind:'body',postId,deadline:work.deadline,generation:work.generation,requestBaseline:work.requestBaseline});}
            if(ids.length)this.queue.push(work);continue;
          }
          if(work.kind==='media-source'){
            const ids=this.mediaSync?.pendingPosts(work.subreddit,workSession)??[];
            // Save observed files before opening another browser page for discovery.
            ids.sort((a,b)=>Number(!this.store.getPost(a)?.attachments.length)-Number(!this.store.getPost(b)?.attachments.length));
            for(const postId of ids)this.queue.push({id:randomUUID(),kind:'media',postId,deadline:work.deadline,generation:work.generation});
            if(ids.length)this.queue.push(work);
            continue;
          }
          const requestBaseline=work.requestBaseline??startingRequests;
          const isTumblr=Boolean(this.sourceOf(work)&&feedIdentity(this.sourceOf(work)!).platform==='tumblr');
          const remaining=isTumblr?Number.MAX_SAFE_INTEGER:120-(this.redditRequests()-requestBaseline);
          if(remaining<=0)throw new SyncLimitError(work.requestBaseline!==undefined?'Archive media request budget reached; Resume archive to save remaining media.':'Sync request budget reached; Resume to fetch remaining posts and media.');
          if(work.kind==='media'){
            const plan=this.mediaSync?.preparePost(work.postId,workSession);if(!plan)continue;
            const post=this.store.getPost(work.postId);if(!post)continue;
            this.reports?.observe(post.subreddit,[post],[post.id]);
            this.message=`Saving media for ${feedIdentity(post.subreddit).label}: ${post.title}`;
            if(plan.discover&&feedIdentity(post.subreddit).platform==='tumblr'){
              if(this.browserOpen&&this.mediaMode)await this.closeBrowser();
              await this.openBrowser(120-(this.redditRequests()-requestBaseline),'tumblr');
              this.attemptedBodies.add(post.id);
              const saved=await this.fetchTumblrPost(post,work.generation);if(!saved)continue;this.controller.signal.throwIfAborted();
              this.store.saveCollectedPost(work.generation,saved);
              if(!saved.attachments?.length){const current=this.store.getPost(post.id)!;if(hasExternalAttachment(current))this.store.setMediaSync(work.generation,post.id,'unavailable',externalAttachmentNote(current),workSession);else if(current.media.some(kind=>kind==='Image'||kind==='Video'))throw new ExtractionError('post-content','Tumblr did not expose its supported media; collection is incomplete',{expectedId:post.id,missingFields:['attachments']});continue;}
            }else if(plan.discover){
              if(this.browserOpen&&!this.mediaMode)await this.closeBrowser();
              await this.openBrowser(120-(this.redditRequests()-requestBaseline),'media');
              const page=await this.browser.navigate(this.pageUrl=post.permalink.replace('https://www.reddit.com','https://old.reddit.com'),this.controller.signal);
              const account=await this.account(page);this.controller.signal.throwIfAborted();if(!account)throw new AccessError('Saved sign-in is unavailable');this.verifyRedditAccount(account);
              let attachments;
              try{attachments=await this.discover(page,post.id,()=>this.browser.mediaCandidates??[],this.controller.signal);}
              catch(error){
                this.controller.signal.throwIfAborted();
                if(!(error instanceof PostUnavailableError))throw error;
                this.store.markPostUnavailable(work.generation,post.id,error.availability);
                await this.mediaSync?.reconcile?.();
                this.store.noteSyncGap(post.subreddit);
                this.message=`r/${post.subreddit}: post ${error.availability}; continuing sync`;
                await this.closeBrowser();continue;
              }
              this.controller.signal.throwIfAborted();
              if(!attachments.length)throw new Error('Media discovery found no download link; sync this feed again to retry');
              this.store.saveMediaReferences(work.generation,post.id,attachments);
              this.store.setMediaSync(work.generation,post.id,'downloading',null,workSession);
              await this.mediaSync?.reconcile?.();
            }
            await this.closeBrowser();this.controller.signal.throwIfAborted();
            await this.mediaSync!.syncPost(post.id,workSession,isTumblr?Number.MAX_SAFE_INTEGER:120-(this.redditRequests()-requestBaseline),this.controller.signal);
            this.reports?.observe(post.subreddit,[post],[post.id]);
            const progress=this.store.offlineMedia(post.subreddit);
            this.message=`${feedIdentity(post.subreddit).label}: media saved for ${progress.ready}/${progress.total} posts`;
            continue;
          }
          if(this.browserOpen&&this.mediaMode)await this.closeBrowser();
          const source=this.sourceOf(work),tumblr=source&&feedIdentity(source).platform==='tumblr';
          if(tumblr&&work.kind==='target'){
            const target=this.store.getTarget(work.targetId);if(!target||['done','cancelled'].includes(target.status))continue;
            const state=tumblrHistoryCheckpoint(target);
            if(state){await this.tumblrHistoryStep(work,target,state);continue;}
            if(target.continuation&&new URL(target.continuation).pathname.startsWith('/search/')){await this.tumblrHistoryStep(work,target,newTumblrHistory(target));continue;}
          }
          await this.openBrowser(120-(this.redditRequests()-requestBaseline),tumblr?'tumblr':false);
          this.controller.signal.throwIfAborted();
          if (work.kind === 'target') {
            const target = this.store.getTarget(work.targetId);
            if (!target || ['done','cancelled'].includes(target.status)) continue;
            this.message = `Syncing ${feedIdentity(target.subreddit).label} · ${target.observedCount} posts encountered`;
            const head = target.continuation === null || target.continuation===listingUrl(target.subreddit);
            const url = target.continuation ?? listingUrl(target.subreddit);
            const listingPage=await this.browser.navigate(this.pageUrl=url,this.controller.signal);
            const listing=tumblr?await readTumblrListing(listingPage,target.subreddit,{
              ...this.tumblrUnavailableOptions(target.subreddit),
              navigate:next=>this.browser.navigate(this.pageUrl=next,this.controller!.signal),
              excluded:id=>this.store.isPostExcluded(id),
              knownDate:id=>{const post=this.store.getPost(id);return post?{epochMs:post.createdMs,precisionMs:post.precisionMs}:null;},
              knownUnavailable:id=>{const post=this.store.getPost(id);return Boolean(post&&post.availability!=='available');},
              resolved:post=>{
                this.controller!.signal.throwIfAborted();
                const before=this.store.getPost(post.id);
                // Save each resolved post, but retain the listing checkpoint
                // until every card has been validated. Stop/budget errors can
                // then resume without skipping the remainder of this page.
                this.store.commitBatch({generation:work.generation,targetId:target.id,observations:[post],continuation:target.continuation});
                this.reports?.observe(target.subreddit,[before],[post.id]);
                this.attemptedBodies.add(post.id);
                this.message=`${feedIdentity(target.subreddit).label}: saved public post text; media queued`;
              }
            }):await this.listing(listingPage,target.subreddit);
            this.controller.signal.throwIfAborted();
            if (this.store.getTarget(target.id)?.status === 'cancelled') continue;
            if(!tumblr)this.verifyRedditAccount(listing.account);
            if(tumblr&&!listing.next){
              const state=newTumblrHistory(target,listing.posts.map(post=>post.id));
              const previous=listing.posts.map(post=>this.store.getPost(post.id));
              this.store.commitBatch({generation:work.generation,targetId:target.id,observations:listing.posts.map(post=>post.bodyNeedsFetch&&this.attemptedBodies.has(post.id)?{...post,body:undefined,bodyNeedsFetch:false}:post),omissions:listing.omissions,unavailablePostIds:listing.unavailableIds,continuation:tumblrCheckpointUrl(target.subreddit,state),boundary:{...target.boundary,source:state},fromHead:head,pageUrl:url});
              this.reports?.observe(target.subreddit,previous,listing.posts.map(post=>post.id));
              this.queueMediaSource(target.subreddit,work.deadline);this.queueBodies(target.subreddit,work.deadline);this.queue.push({...work,head:false});continue;
            }
            const result = advanceBoundary(target, listing, this.store.hasBatch(target.id, listing.signature));
            const previous=listing.posts.map(post=>this.store.getPost(post.id));
            this.store.commitBatch({ generation: work.generation, targetId: target.id, observations: listing.posts.map(post=>post.bodyNeedsFetch&&this.attemptedBodies.has(post.id)?{...post,body:undefined,bodyNeedsFetch:false}:post),
              continuation: listing.next, omissions: listing.omissions,unavailablePostIds:listing.unavailableIds, boundary: result.boundary, batchKey: listing.signature,
              fromHead: head, pageUrl:url, completion:result.completion,
              status: result.done ? 'done' : result.stalled ? 'paused' : 'queued',
              reason: result.reason ?? (result.stalled ? 'Listing repeated three times; continuation needs inspection' : undefined) });
            this.reports?.observe(target.subreddit,previous,listing.posts.map(post=>post.id));
            await this.mediaSync?.reconcile?.();
            this.controller.signal.throwIfAborted();
            this.message = `${feedIdentity(target.subreddit).label}: ${listing.posts.length} posts checked${listing.omissions ? `, ${listing.omissions} omitted` : ''}`;
            if (!result.done && !result.stalled) this.queue.push({ ...work, head: false });
            this.queueMediaSource(target.subreddit,work.deadline);
            this.queueBodies(target.subreddit,work.deadline);
          } else if(work.kind==='thread'||work.kind==='body') {
            const post = this.store.getPost(work.postId);
            if (!post) continue;
            if(work.kind==='body'){
              if(!this.store.bodySync(post.id)||this.store.bodySync(post.id)?.status==='ready')continue;
              this.attemptedBodies.add(post.id);this.store.setBodySync(work.generation,post.id,'fetching');
            }
            this.message = work.kind==='body'?`Saving post text: ${post.title}`:`Reading discussion: ${post.title}`;
            if(tumblr&&work.kind==='body'){
              const saved=await this.fetchTumblrPost(post,work.generation);if(!saved)continue;this.controller.signal.throwIfAborted();
              this.store.saveCollectedPost(work.generation,saved);
              await this.mediaSync?.reconcile?.();
              this.controller.signal.throwIfAborted();
              if(this.mediaSync&&this.store.mediaSync(post.id))this.queue.push({id:randomUUID(),kind:'media',postId:post.id,deadline:work.deadline,generation:work.generation});
              this.reports?.observe(post.subreddit,[post],[post.id]);this.message='Tumblr post text and attachment references saved';continue;
            }
            const page = await this.browser.navigate(this.pageUrl=(tumblr?tumblrPostUrl(post.id):post.permalink.replace('https://www.reddit.com', 'https://old.reddit.com')), this.controller.signal);
            const account = await this.account(page);
            this.controller.signal.throwIfAborted();
            if (!account) throw new AccessError('Saved sign-in is unavailable');
            this.verifyRedditAccount(account);
            const { snapshot, attachments } = await this.discussion(page, post.id);
            this.controller.signal.throwIfAborted();
            if(work.kind==='body'){
              if(snapshot.availability!=='available'){this.store.markPostUnavailable(work.generation,post.id,snapshot.availability,snapshot.observedAt);this.store.noteSyncGap(post.subreddit);}
              else if(snapshot.body===null)throw new ExtractionError('post-content','The complete post body was not exposed; Resume to retry',{missingFields:['body']});
              else this.store.savePostBody(work.generation,post.id,snapshot.body,snapshot.observedAt,snapshot.author);
            }else this.store.saveSnapshot(work.generation, snapshot);
            if(attachments)this.store.saveMediaReferences(work.generation,post.id,attachments);
            await this.mediaSync?.reconcile?.();
            this.controller.signal.throwIfAborted();
            if(this.mediaSync&&this.store.followedSources().includes(post.subreddit)&&this.store.mediaSync(post.id))this.queue.push({id:randomUUID(),kind:'media',postId:post.id,deadline:work.deadline,generation:work.generation});
            this.reports?.observe(post.subreddit,[post],[post.id]);
            this.message = work.kind==='body'?'Post text saved offline':`Discussion saved: ${snapshot.comments.length} sampled comments; sort ${snapshot.sort}`;
          }
        } catch (error) {
          const reason=error instanceof Error?error.message:'Collection failed';
          if (this.stoppedWork.has(work.id)) {
            await this.closeBrowser();
          } else if (!this.stopping) {
            const blocked=error instanceof PostIdentityError?error.expectedId:error instanceof ExtractionError&&error.code==='post-content'?error.facts.expectedId:null,source=this.sourceOf(work);
            if(blocked&&source)this.store.noteBlockedPost(source,blocked);
            this.problem(error);
            if(error instanceof SyncLimitError){this.accessFailure(new AccessError(reason),false);}
            else if((work.kind==='media'||work.kind==='body')&&(error instanceof UnsupportedMediaError||(!(error instanceof AccessError)&&!(error instanceof PostIdentityError)&&!/sign.in|account|block|verification|layout|does not match|request control/i.test(reason)))){
              if(work.kind==='media')this.store.setMediaSync(work.generation,work.postId,error instanceof UnsupportedMediaError?'unavailable':'failed',reason,workSession);
              else this.store.setBodySync(work.generation,work.postId,'failed',reason);
              this.message=`${work.kind==='body'?'Post text':'Media'} ${error instanceof UnsupportedMediaError?'unavailable':'failed'}: ${reason}`;
              await this.closeBrowser();
            }else{
              const source=this.sourceOf(work),tumblr=source&&feedIdentity(source).platform==='tumblr';
              const global=error instanceof StorageLimitError||/request control|browser.*(?:launch|closed|failed)|context.*closed|executable|spawn|ENOSPC|Protocol error/i.test(reason);
              const access=error instanceof AccessError||error instanceof ExtractionError&&error.code==='access'||/sign.in|denied access|block|verification/i.test(reason);
              if(!tumblr&&/sign.in|account/i.test(reason))this.signInStatus.reddit={...this.signInStatus.reddit,state:'error'};
              if(tumblr&&!global){if(access)this.accessFailure(new AccessError(reason,error instanceof AccessError?error.notBefore:null,'tumblr'),false);else await this.stopSource(source!,reason);}
              else this.pause(reason);
              if (this.sourceOf(work)&&feedIdentity(this.sourceOf(work)!).platform!=='tumblr'&&(error instanceof AccessError || /sign.in|account|block|verification/i.test(reason))) this.store.setSetting('accessPause', { reason, notBefore: error instanceof AccessError ? error.notBefore : null });
            }
          }
        } finally {
          if(work.kind==='media'&&this.store.mediaSync(work.postId)?.status==='downloading'){const reason=this.store.mediaSync(work.postId)?.reason;this.store.setMediaSync(work.generation,work.postId,'pending',reason?.startsWith('Media URL expired')?reason:'Sync interrupted; Resume to finish saving this feed',workSession);}
          if(work.kind==='body'&&this.store.bodySync(work.postId)?.status==='fetching')this.store.setBodySync(work.generation,work.postId,'pending','Sync interrupted; Resume to finish saving post text');
          this.stoppedWork.delete(work.id);
          this.active=null;this.finishFeeds();
        }
      }
    } finally {
      try { await this.closeBrowser(); }
      finally {
        this.active = null; this.controller = null; this.pumping = false;
        this.finishFeeds();
        if (this.queue.length && !this.stopping) this.start();
      }
    }
  }
}
