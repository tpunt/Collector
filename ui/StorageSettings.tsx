import React,{useEffect,useState} from 'react';
import {MEDIA_FILTERS} from '../src/domain.ts';
import type {LibraryStorage,CleanupPreview} from '../src/library-storage.ts';

const size=(bytes:number)=>bytes>=1_000_000_000?(bytes/1_000_000_000).toFixed(2)+' GB':bytes>=1_000_000?(bytes/1_000_000).toFixed(2)+' MB':bytes>=1000?(bytes/1000).toFixed(1)+' KB':bytes+' B';
export function StorageSettings({token,changed,setBusy}:{token:string;changed:()=>Promise<void>;setBusy:(busy:boolean)=>void}){
  const [storage,setStorage]=useState<LibraryStorage|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[working,setWorking]=useState(false);
  const [feed,setFeed]=useState(''),[kind,setKind]=useState(''),[before,setBefore]=useState(''),[readOnly,setReadOnly]=useState(true),[preview,setPreview]=useState<CleanupPreview|null>(null);
  async function refresh(){const response=await fetch('/api/storage'),value=await response.json();if(!response.ok)throw new Error(value.error);setStorage(value);}
  useEffect(()=>{void refresh().catch(error=>setError(error.message));},[]);
  useEffect(()=>setPreview(null),[feed,kind,before,readOnly]);
  async function post(path:string,data:unknown){const response=await fetch('/api/storage/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new Error(value.error);return value;}
  async function run(work:()=>Promise<void>){setWorking(true);setBusy(true);setError('');setMessage('');try{await work();}catch(error){setError((error as Error).message);}finally{setWorking(false);setBusy(false);}}
  return <section className="storage-management">
    <div className="storage-heading"><h3>Storage breakdown</h3><button className="button" disabled={working} onClick={()=>void run(refresh)}>Refresh sizes</button><button className="button" disabled={working} onClick={()=>void run(async()=>{const result=await post('compact',{});setMessage(result.warning??'Freed database space and unassigned cache files reclaimed. Posts kept.');await refresh();await changed();})}>Reclaim freed space</button></div>
    {storage?<><dl className="storage-totals"><div><dt>Database + search index</dt><dd>{size(storage.databaseBytes)}</dd></div><div><dt>Media + cache metadata</dt><dd>{size(storage.mediaBytes)}</dd></div><div><dt>Total</dt><dd>{size(storage.totalBytes)}</dd></div></dl>
      <p className="muted">{storage.types.map(type=>`${type.kind==='other'?'Unverified':type.kind==='image'?'Images':'Videos'}: ${type.files.toLocaleString()} · ${size(type.bytes)}`).join(' / ')}</p>
      <div className="storage-table"><table><thead><tr><th>Feed</th><th>Posts</th><th>Attributed media</th><th>Exclusive media</th><th>Shared files</th></tr></thead><tbody>{storage.feeds.map(feed=><tr key={feed.feed}><th>r/{feed.feed}{!feed.subscribed&&<small>Unsubscribed</small>}</th><td>{feed.posts.toLocaleString()}</td><td>{size(feed.bytes)}</td><td>{size(feed.exclusiveBytes)}</td><td>{feed.sharedFiles.toLocaleString()}</td></tr>)}</tbody></table></div>
      <p className="muted">Shared media ({size(storage.sharedBytes)}) is divided across its owning feeds, so attributed bytes add up without counting files twice. Shared-file counts may overlap. Database allocation is global; browser profiles and temporary files are excluded.{storage.unassignedBytes>0&&` Unassigned cache files: ${size(storage.unassignedBytes)}.`}</p>
    </>:<p role="status">Reading local file sizes…</p>}
    <h3>Delete selected posts</h3><p className="muted">Preview and reclaim pause collection. Confirmation deletes matching posts, discussions and files that no other post uses. Deleted posts stay excluded from future syncs and archives. No automatic eviction or media-only deletion.</p>
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{setPreview(await post('preview',{feed,kind,before,readOnly}));});}}>
      <div className="cleanup-fields"><label>Cleanup feed<select aria-label="Cleanup feed" value={feed} disabled={working} onChange={event=>setFeed(event.target.value)}><option value="">All stored feeds</option>{storage?.feeds.map(feed=><option key={feed.feed} value={feed.feed}>r/{feed.feed}{feed.subscribed?'':' (unsubscribed)'}</option>)}</select></label>
      <label>Cleanup post type<select aria-label="Cleanup post type" value={kind} disabled={working} onChange={event=>setKind(event.target.value)}><option value="">All post types</option>{MEDIA_FILTERS.map(kind=><option key={kind}>{kind}</option>)}</select></label>
      <label>Before date (UTC, optional)<input aria-label="Before date (UTC, optional)" type="date" disabled={working} value={before} onChange={event=>setBefore(event.target.value)}/></label></div>
      <label className="cleanup-read"><input type="checkbox" checked={readOnly} disabled={working} onChange={event=>setReadOnly(event.target.checked)}/>Read posts only</label>
      <button className="button" disabled={working||!storage}>Preview deletion</button>
    </form>
    {preview&&<div className="cleanup-preview" role="group" aria-label="Confirm selective deletion"><p><strong>{preview.posts.toLocaleString()} posts</strong> · {preview.files.toLocaleString()} media files · about {size(preview.reclaimableBytes)} of media reclaimable</p><p>{preview.sharedFilesKept.toLocaleString()} shared files will be kept. Database space is reclaimed where possible after deletion; its saving is not included in this estimate. Preview expires in 10 minutes.</p>
      {preview.examples.length>0&&<ul>{preview.examples.map(post=><li key={post.id}>r/{post.feed} · {post.title}</li>)}</ul>}
      {preview.posts>preview.examples.length&&<p className="muted">Showing {preview.examples.length} of {preview.posts.toLocaleString()} matching posts.</p>}
      <div className="dialog-actions"><button className="button" disabled={working} onClick={()=>void run(async()=>{await post('discard',{id:preview.id});setPreview(null);})}>Keep posts</button><button className="button danger" disabled={working||!preview.posts} onClick={()=>void run(async()=>{
        const result=await post('delete',{id:preview.id,confirm:true});setPreview(null);setMessage(`${result.deleted.toLocaleString()} posts deleted. ${result.warning??''}`);await refresh();await changed();
      })}>Delete {preview.posts.toLocaleString()} posts</button></div>
    </div>}
    {working&&<p role="status">Working on local storage…</p>}{message&&<p role="status">{message}</p>}{error&&<p className="notice error" role="alert">{error}</p>}
  </section>;
}
