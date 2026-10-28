import {WebSocket} from 'ws';
import type {ReaderStore} from './store.ts';
import type {ReaderJobs} from './jobs.ts';
import type {PausedTask} from './jobs.ts';
import type {ArchiveFetcher} from './archive-fetch.ts';
import type {MediaCache} from './media.ts';
import type {RequestQueue} from './request-gate.ts';

interface PausedWork {generation:number;feeds:string[];tasks:PausedTask[];archive:string|null;signIn:boolean}
export interface NetworkStatus {offline:boolean;changing:boolean;pendingReaders:number;revision:number;message:string;paused:{feeds:string[];threads:number;archive:boolean;signIn:boolean}}
const REASON='Paused for Offline mode; progress saved';

/** One source-neutral policy for collection, file downloads and open reader tabs. */
export class NetworkMode {
  private changing=false;
  private revision=Date.now();
  private message='';
  private clients=new Map<string,{socket:WebSocket;ack:number}>();
  private checks=new Set<()=>void>();
  private readers:{ids:string[];revision:number}|null=null;
  private store:ReaderStore;
  private network:RequestQueue;
  private jobs:ReaderJobs;
  private archive:ArchiveFetcher;
  private media:MediaCache;
  constructor(store:ReaderStore,network:RequestQueue,jobs:ReaderJobs,archive:ArchiveFetcher,media:MediaCache){
    this.store=store;this.network=network;this.jobs=jobs;this.archive=archive;this.media=media;
    const saved=store.getSetting('offlineMode');network.setOffline(saved!==null&&saved!==false);
    if(!network.offline&&store.getSetting('offlineResume'))this.save(this.empty());
  }
  private empty():PausedWork{return{generation:this.store.generation,feeds:[],tasks:[],archive:null,signIn:false};}
  private source(task:PausedTask){return'subreddit'in task?task.subreddit:this.store.getPost(task.postId)?.subreddit;}
  private plan():PausedWork {
    const value=this.store.getSetting<PausedWork>('offlineResume');if(!value||value.generation!==this.store.generation)return this.empty();
    const followed=this.store.followedSources();
    return{generation:value.generation,feeds:Array.isArray(value.feeds)?value.feeds.filter(name=>followed.includes(name)):[],
      tasks:Array.isArray(value.tasks)?value.tasks.filter(task=>task&&(['media-source','body-source'].includes(task.kind)?'subreddit'in task&&followed.includes(task.subreddit):['thread','media','body'].includes(task.kind)&&'postId'in task&&typeof task.postId==='string'&&this.store.getPost(task.postId))):[],
      archive:typeof value.archive==='string'&&this.store.archiveFetch(value.archive)&&followed.includes(this.store.archiveFetch(value.archive)!.subreddit)?value.archive:null,signIn:value.signIn===true};
  }
  private save(plan:PausedWork){this.store.setSetting('offlineResume',plan);}
  private pendingReaders(){return this.readers?.ids.filter(id=>{const client=this.clients.get(id);return client&&client.ack<this.readers!.revision;}).length??0;}
  get status():NetworkStatus {const plan=this.plan();return{offline:this.network.offline,changing:this.changing,pendingReaders:this.network.offline?this.pendingReaders():0,revision:this.revision,message:this.message,
    paused:{feeds:[...new Set([...plan.feeds,...plan.tasks.filter(task=>task.kind!=='thread').map(task=>this.source(task)),plan.archive?this.store.archiveFetch(plan.archive)?.subreddit:null].filter((name):name is string=>Boolean(name)))],threads:plan.tasks.filter(task=>task.kind==='thread').length,archive:Boolean(plan.archive),signIn:plan.signIn}};}
  private publish(){
    this.revision=Math.max(Date.now(),this.revision+1);const event=JSON.stringify(this.status);
    for(const {socket}of this.clients.values())if(socket.readyState===WebSocket.OPEN)socket.send(event);
    for(const check of this.checks)check();
  }
  subscribe(id:string,socket:WebSocket){
    this.clients.get(id)?.socket.terminate();
    const client={socket,ack:0};this.clients.set(id,client);
    socket.on('message',data=>{try{const value=JSON.parse(String(data));if(this.clients.get(id)===client)this.acknowledge(id,value.revision);}catch{socket.close(1008,'Invalid acknowledgement');}});
    socket.on('error',()=>socket.terminate());
    socket.send(JSON.stringify(this.status));
    const heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.ping();},15_000);
    socket.once('close',()=>{clearInterval(heartbeat);if(this.clients.get(id)===client)this.clients.delete(id);for(const check of this.checks)check();});
  }
  close(){for(const {socket}of this.clients.values())socket.terminate();}
  private acknowledge(id:string,revision:number){const client=this.clients.get(id);if(client&&Number.isSafeInteger(revision)&&revision<=this.revision)client.ack=Math.max(client.ack,revision);for(const check of this.checks)check();}
  private readersPaused(ids:string[],revision:number){
    this.readers={ids,revision};
    return new Promise<void>(resolve=>{
      let returned=false,last=ids.length;
      // An unresponsive renderer must not freeze the controls or be counted as paused.
      const timeout=setTimeout(()=>{returned=true;resolve();},5000);
      const check=()=>{
        const pending=this.pendingReaders();
        if(!pending||!this.network.offline){
          this.checks.delete(check);this.readers=null;clearTimeout(timeout);resolve();
          if(returned&&!this.changing&&this.network.offline){this.message='Offline mode is on. Paused work resumes when it is turned off.';this.publish();}
        }else if(returned&&!this.changing&&pending!==last){last=pending;this.publish();}
      };
      this.checks.add(check);check();
    });
  }
  cancel(input:{source?:string;post?:string}={}){
    const plan=this.plan();
    if(input.source){plan.feeds=plan.feeds.filter(name=>name!==input.source);plan.tasks=plan.tasks.filter(task=>this.source(task)!==input.source);if(plan.archive&&this.store.archiveFetch(plan.archive)?.subreddit===input.source)plan.archive=null;}
    else if(input.post)plan.tasks=plan.tasks.filter(task=>!('postId'in task)||task.postId!==input.post);
    else{this.save(this.empty());this.publish();return;}
    this.save(plan);this.publish();
  }
  async change(offline:boolean):Promise<NetworkStatus>{
    if(this.changing)throw new Error('Offline mode is changing; wait for it to finish');
    if(offline===this.network.offline){this.publish();return this.status;}
    if(offline){
      const active=this.archive.active,work=this.store.getSetting('accessPause')?{feeds:[],tasks:[],signIn:false}:this.jobs.offlineWork();
      this.changing=true;
      try{
        this.store.setSettings({offlineResume:{generation:this.store.generation,...work,feeds:work.feeds.filter(name=>active?.state!=='running'||name!==active.subreddit),tasks:work.tasks.filter(task=>task.kind==='thread'||active?.state!=='running'||this.source(task)!==active.subreddit),archive:active?.state==='running'?active.id:null},offlineMode:true});
        this.network.setOffline(true);this.message='Pausing collection and online players…';
        const readers=[...this.clients.keys()];this.publish();const paused=this.readersPaused(readers,this.revision);
        // Close concurrently: an archive media phase can be awaiting the job queue.
        this.archive.pause(REASON);this.jobs.pause(REASON);this.media.stop();
        const results=await Promise.allSettled([this.jobs.close(REASON),this.archive.close(REASON),this.media.close(),paused]);
        if(results.some(result=>result.status==='rejected')){
          this.message='Offline mode is on; network access is blocked. A collection window could not finish closing. Close it before resuming.';
          throw new Error(this.message);
        }
        this.message=this.pendingReaders()?'Collection is paused; waiting for open readers to confirm that online players have paused.':'Offline mode is on. Paused work resumes when it is turned off.';
      }
      finally{this.changing=false;this.publish();}
    }else{
      const plan=this.plan();this.store.setSettings({offlineResume:this.empty(),offlineMode:false});this.network.setOffline(false);this.message='Online';
      const errors:string[]=[];
      if(this.store.getSetting('accessPause')&&(plan.feeds.length||plan.tasks.length||plan.archive||plan.signIn))errors.push('Collection needs an explicit Resume after its service pause');
      else{
        if(plan.archive)try{this.archive.resume(plan.archive);}catch(error){errors.push((error as Error).message);}
        if(plan.feeds.length)try{this.jobs.syncFeeds(plan.feeds);}catch(error){errors.push((error as Error).message);}
        if(plan.tasks.length)try{this.jobs.resumeOfflineTasks(plan.tasks);}catch(error){errors.push((error as Error).message);}
        if(plan.signIn)void this.jobs.signIn().catch(error=>{if(!this.network.offline){this.message='Sign-in needs attention: '+(error as Error).message;this.publish();}});
      }
      if(errors.length)this.message='Online. Some work remains paused: '+[...new Set(errors)].join('; ');
      this.publish();
    }
    return this.status;
  }
}
