import React,{useEffect,useState} from 'react';
import type {ProblemLog} from '../src/problems.ts';
type Problems=ReturnType<ProblemLog['list']>;
const time=(ms:number)=>new Date(ms).toLocaleString();
export function ProblemsPanel({token,changed,setBusy}:{token:string;changed:()=>Promise<void>;setBusy:(value:boolean)=>void}){
  const [data,setData]=useState<Problems|null>(null),[error,setError]=useState(''),[working,setWorking]=useState(false);
  async function refresh(){const response=await fetch('/api/problems');if(!response.ok)throw new Error('Could not read the local problem log');setData(await response.json());}
  useEffect(()=>{void refresh().catch(error=>setError(error.message));},[]);
  async function run(work:()=>Promise<void>){setWorking(true);setBusy(true);setError('');try{await work();}catch(error){setError((error as Error).message);}finally{setWorking(false);setBusy(false);}}
  return <section className="problems-panel">
    <p className="muted">Problems only. Repeats are grouped with occurrence counts; no request-by-request activity log. Marking a problem as seen keeps its diagnostic record and does not resume collection.</p>
    <div className="problem-tools"><button className="button" disabled={working} onClick={()=>void run(refresh)}>Refresh problems</button><button className="button" disabled={working||!data?.unseen} onClick={()=>void run(async()=>{const response=await fetch('/api/problems/acknowledge',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify({records:data!.records.map(row=>({id:row.id,count:row.count}))})});if(!response.ok)throw new Error('Could not mark problems as seen');setData(await response.json());await changed();})}>Mark displayed problems as seen</button><a className="button" href="/api/problems/download" download="collector-problems.json">Download diagnostics</a></div>
    {data&&<><p className="muted">{data.groups} retained problem groups · {data.unseen} unseen occurrences. Up to {data.maxEntries} groups / {Math.round(data.maxBytes/1024)} KiB. Repeat-only updates are coalesced for one minute; all automatic writes share a limit of 20 per minute. Counters stay current in memory and flush on normal shutdown.</p><p className="problem-path">Local log: <code>{data.path}</code></p><p className="muted">No post text, raw HTML, screenshots, credentials, cookies, URL query strings or full CDN paths. Diagnostics are local and excluded from library backups.</p>{data.dropped>0&&<p className="muted">{data.dropped} older groups rotated out of the bounded log.</p>}{data.writeError&&<p className="notice error" role="alert">{data.writeError}</p>}
      {!data.records.length&&<p>No problems recorded.</p>}
      <div className="problem-records">{data.records.map(row=><details className="problem-record" key={row.id}><summary><strong>{row.message}</strong><span>{row.count} occurrence{row.count===1?'':'s'}{row.count>row.seen?' · New':''}{row.feed?` · ${row.platform} / ${row.feed}`:''}</span></summary><dl><div><dt>First</dt><dd>{time(row.firstAt)}</dd></div><div><dt>Last</dt><dd>{time(row.lastAt)}</dd></div><div><dt>Operation / code</dt><dd>{row.operation} / {row.code}</dd></div></dl><p className="muted">Up to three bounded diagnostic samples. Stack locations reference Collector source files; website content and raw error messages are excluded.</p><pre>{JSON.stringify(row.samples,null,2)}</pre></details>)}</div>
    </>}
    {error&&<p className="notice error" role="alert">{error}</p>}
  </section>;
}
