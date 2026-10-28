import React,{useEffect,useRef,useState} from 'react';
import type {CollectionReport} from '../src/collection-report.ts';
import type {OfflineMediaCounts} from '../src/store.ts';

type Issues={items:{id:string;title:string;status:string;reason:string|null}[];next:string|null};
const stamp=(ms:number)=>new Date(ms).toLocaleString();
export function CollectionReportPanel({feed,report,counts,offline,busy,retry,openPost}:{feed:string;report:CollectionReport|null;counts:OfflineMediaCounts;offline:boolean;busy:boolean;retry:()=>void;openPost:(id:string)=>void}){
  const requestVersion=useRef(0);
  const [issues,setIssues]=useState<Issues>({items:[],next:null}),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  async function load(after:string|null=null){
    const version=++requestVersion.current;setLoading(true);setError('');
    try{const response=await fetch('/api/media/issues?'+new URLSearchParams({feed,...(after?{after}:{})}));const value=await response.json();if(!response.ok)throw new Error(value.error);if(version!==requestVersion.current)return;setIssues(old=>({items:after?[...new Map([...old.items,...value.items].map(item=>[item.id,item])).values()]:value.items,next:value.next}));}
    catch(error){if(version===requestVersion.current)setError((error as Error).message);}finally{if(version===requestVersion.current)setLoading(false);}
  }
  useEffect(()=>{void load();},[feed,counts.pending,counts.failed,counts.ready,counts.unavailable]);
  return <div className="collection-report">
    {report?<><p>{report.kind==='retry'?'Download retry':report.kind==='archive'?'Archive collection':'Feed sync'} · {report.state==='running'?'In progress':report.state==='paused'?'Incomplete / paused':'Finished'}</p><p className="muted">Started {stamp(report.startedAt)}{report.finishedAt?' · Ended '+stamp(report.finishedAt):''}</p><dl className="report-counts"><div><dt>Posts checked</dt><dd>{report.checkedPosts}</dd></div><div><dt>New posts</dt><dd>{report.newPosts}</dd></div><div><dt>Updated posts</dt><dd>{report.updatedPosts}</dd></div><div><dt>Text completed</dt><dd>{report.textCompleted??0}</dd></div><div><dt>Files saved</dt><dd>{report.filesSaved} · {(report.bytesSaved/1_000_000).toFixed(1)} MB</dd></div></dl>{report.reason&&<p>{report.reason}</p>}</>:<p>No collection report yet. The next sync will create one.</p>}
    <h3>Current media status</h3><p>{counts.ready} posts offline · {counts.pending} pending · {counts.failed} retryable · {counts.unavailable} unavailable / online only</p>
    <button className="button" disabled={offline||busy||report?.state==='running'||!counts.pending&&!counts.failed} onClick={retry}>Retry incomplete downloads</button><p className="muted">Retries pending and failed media for this feed, including discovery when needed. Keeps saved files and history checkpoints. Unavailable files and online-only players are left alone. Each retry uses the existing request budget and spacing.</p>
    <ul className="media-issues">{issues.items.map(item=><li key={item.id}><button onClick={()=>openPost(item.id)}>{item.title}</button><span className="badge">{item.status==='failed'?'Retryable':item.status==='unavailable'?'Unavailable / online only':'Pending'}</span>{item.reason&&<p>{item.reason}</p>}</li>)}</ul>
    {issues.next&&<button className="button" disabled={loading} onClick={()=>void load(issues.next)}>More media issues</button>}{error&&<p role="alert">{error}</p>}
  </div>;
}
