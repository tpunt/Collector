import React, {useEffect, useRef, useState} from 'react';
import type {StoredPost,MediaSyncState} from '../src/store.ts';
import type {MediaItem} from '../src/media.ts';

/** Reading the feed only reads local status/files. Sync owns every remote download. */
export function PostMedia({post,syncing,revision,children}:{post:StoredPost;syncing:boolean;revision:number;children?:(copyLocalPath:React.ReactNode)=>React.ReactNode}) {
  const ref=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(false),[items,setItems]=useState<MediaItem[]>([]),[error,setError]=useState(''),[sync,setSync]=useState<MediaSyncState|null>(null);
  const [copyStatus,setCopyStatus]=useState('Copy local path');
  const signature=post.attachments?.map(item=>item.url).join('|')??'';
  const hasMedia=post.availability==='available'&&post.media.some(kind=>kind==='Image'||kind==='Video');
  async function copyPaths(paths:string[]) {
    try{await navigator.clipboard.writeText(paths.join('\n'));setCopyStatus('Copied');}
    catch{setCopyStatus('Copy failed');}
  }
  useEffect(()=>{
    if(copyStatus==='Copy local path')return;
    const timer=setTimeout(()=>setCopyStatus('Copy local path'),2000);return()=>clearTimeout(timer);
  },[copyStatus]);
  useEffect(()=>{
    if(!ref.current||!hasMedia)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}});
    observer.observe(ref.current);return()=>observer.disconnect();
  },[post.id,hasMedia]);
  useEffect(()=>{
    if(!visible||!hasMedia)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    async function poll(){
      try{
        const response=await fetch('/api/media/'+post.id),value:{items:MediaItem[];sync:MediaSyncState|null}=await response.json();
        if(!response.ok)throw new Error('Could not load local media status');if(disposed)return;setItems(value.items);setSync(value.sync);setError('');
      }catch(e){if(!disposed)setError((e as Error).message);}
      if(!disposed&&syncing)timer=setTimeout(()=>void poll(),1000);
    }
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[visible,hasMedia,syncing,post.id,signature,revision]);
  const ready=hasMedia?items.filter(item=>item.state==='ready'):[];
  const paths=ready.flatMap(item=>item.localPath?[item.localPath]:[]);
  const copyLocalPath=paths.length>0?<button type="button" className="copy-local-path" title={paths.join('\n')} aria-live="polite" onClick={()=>void copyPaths(paths)}>{copyStatus}</button>:null;
  return <>{children?.(copyLocalPath)}{hasMedia&&<div className="post-media" ref={ref}>
    {ready.length>0&&<div className={'media-items '+(ready.length>1?'gallery':'')}>{ready.map((item,index)=>item.kind==='image'?<a href={item.url!} target="_blank" rel="noreferrer" key={item.key}><img src={item.url!} alt={ready.length>1?`${post.title} — image ${index+1}`:post.title} loading="lazy"/></a>:<video key={item.key} src={item.url!} controls preload="metadata" playsInline aria-label={post.title}/>)}</div>}
    {(ready.length<Math.max(items.length,1)||sync?.status==='unavailable'||sync?.status==='failed')&&<p className="media-note" role="status">{error||(
      sync?.status==='downloading'?'Downloading media during sync…':sync?.status==='unavailable'?`Media unavailable: ${sync.reason}`:
      sync?.status==='failed'?`Media sync failed: ${sync.reason}`:syncing?'Media queued for this sync':'Media not downloaded · Sync this feed to save it offline')}</p>}
  </div>}</>;
}
