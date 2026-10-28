import {randomUUID,createHash} from 'node:crypto';
import type {ReaderStore,StoredPost} from './store.ts';
import {feedName} from './sources.ts';
import {postId} from './domain.ts';

export interface CollectionReport {
  id:string;feed:string;kind:'sync'|'retry'|'archive';state:'running'|'finished'|'paused';
  startedAt:number;finishedAt:number|null;reason:string|null;
  checkedPosts:number;newPosts:number;updatedPosts:number;textCompleted:number;filesSaved:number;bytesSaved:number;
}
const key=(feed:string)=>'collectionReport:'+feedName(feed);
// Compare visible content, never timestamps, download/read status or local preferences.
const fingerprint=(post:StoredPost,bodyPending=false,attachmentsPending=false)=>createHash('sha256').update(JSON.stringify([post.title,bodyPending?null:post.body,post.availability,attachmentsPending?null:post.media,attachmentsPending?null:post.attachments,attachmentsPending?null:post.outbound])).digest('hex');

/** One small persisted report per feed. Per-run fingerprints live only while
 * collecting; reports contain counts, never copies of post bodies. */
export class CollectionReports {
  private active=new Map<string,{report:CollectionReport;generation:number;revision:number;seen:Map<string,{baseline:string|null;changed:boolean;bodyPending:boolean;attachmentsPending:boolean;textCompleted:boolean}>}>();
  private store:ReaderStore;
  constructor(store:ReaderStore){this.store=store;}
  get(feed:string):CollectionReport|null {
    const saved=this.store.getSetting<CollectionReport>(key(feed));
    if(!saved)return null;
    return saved.state==='running'&&!this.current(feed)?{...saved,state:'paused',reason:'Application restarted; progress saved. Start a sync or retry explicitly.'}:saved;
  }
  private current(feed:string){const item=this.active.get(feed);return item&&item.generation===this.store.generation&&item.revision===this.store.sourceRevision(feed)?item:null;}
  begin(feed:string,kind:CollectionReport['kind']){
    feed=feedName(feed);
    const report:CollectionReport={id:randomUUID(),feed,kind,state:'running',startedAt:Date.now(),finishedAt:null,reason:null,checkedPosts:0,newPosts:0,updatedPosts:0,textCompleted:0,filesSaved:0,bytesSaved:0};
    this.active.set(feed,{report,generation:this.store.generation,revision:this.store.sourceRevision(feed),seen:new Map()});this.save(feed);return report.id;
  }
  observe(feed:string,before:(StoredPost|null)[],ids:string[]){
    const item=this.current(feed);if(!item)return;
    ids.forEach((id,index)=>{
      const after=this.store.getPost(id);if(!after)return;
      let seen=item.seen.get(after.id);
      if(!seen){const previous=before[index],bodyPending=Boolean(previous&&(previous.bodySync&&previous.bodySync.status!=='ready'||previous.body===null&&previous.media.includes('Text'))),attachmentsPending=Boolean(previous&&(bodyPending||!previous.mediaDiscoveryComplete||previous.media.some(kind=>kind==='Image'||kind==='Video')&&!previous.attachments.length));seen={baseline:previous?fingerprint(previous,bodyPending,attachmentsPending):null,changed:false,bodyPending,attachmentsPending,textCompleted:false};item.seen.set(after.id,seen);item.report.checkedPosts++;if(seen.baseline===null)item.report.newPosts++;}
      if(seen.baseline!==null){const changed=fingerprint(after,seen.bodyPending,seen.attachmentsPending)!==seen.baseline;item.report.updatedPosts+=Number(changed)-Number(seen.changed);seen.changed=changed;if(seen.bodyPending&&!seen.textCompleted&&after.bodySync?.status==='ready'){item.report.textCompleted++;seen.textCompleted=true;}}
    });this.save(feed);
  }
  // Archive cursors already deduplicate boundary replays. Once this page's
  // content is saved, only its counters are needed: deep history must not keep
  // every historical post fingerprint in memory for the whole job.
  releaseArchivePage(feed:string,ids:string[]){const item=this.current(feed);if(item?.report.kind==='archive')for(const id of ids)item.seen.delete(postId(id));}
  saved(feed:string,bytes:number){const item=this.current(feed);if(!item)return;item.report.filesSaved++;item.report.bytesSaved+=bytes;this.save(feed);}
  finish(feed:string,state:'finished'|'paused',reason:string|null=null,expectedId?:string){const item=this.current(feed);if(expectedId&&this.active.get(feed)?.report.id!==expectedId)return;if(item){Object.assign(item.report,{state,reason,finishedAt:Date.now()});this.save(feed);}this.active.delete(feed);}
  private save(feed:string){const item=this.current(feed);if(item)this.store.setSetting(key(feed),item.report);}
}
