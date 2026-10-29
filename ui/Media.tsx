import React, {useEffect, useRef, useState} from 'react';
import type {StoredPost,MediaSyncState} from '../src/store.ts';
import type {MediaItem} from '../src/media.ts';
import {onlineEmbed} from '../src/online-embed.ts';
import {hasExternalAttachment} from '../src/sources.ts';
import {useMediaBrowsing} from './MediaBrowsing.tsx';
import {MediaPreview} from './MediaPreview.tsx';
import {ExternalLink,useNetworkMode} from './NetworkMode.tsx';

/** Sync owns offline downloads. Known external players remain explicitly online. */
export function PostMedia({post,syncing,revision,children,filter,scope='feed',eager=false}:{eager?:boolean;scope?:string;filter?:'image'|'video';post:StoredPost;syncing:boolean;revision:number;children?:(controls:React.ReactNode)=>React.ReactNode}) {
  const {offline}=useNetworkMode(),browsing=useMediaBrowsing();
  const ref=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(false),[items,setItems]=useState<MediaItem[]>([]),[error,setError]=useState<{key:string;message:string}|null>(null),[sync,setSync]=useState<MediaSyncState|null>(null);
  const [loadedKey,setLoadedKey]=useState('');
  const [copyStatus,setCopyStatus]=useState('Copy local path');
  const signature=post.attachments?.map(item=>item.url).join('|')??'';
  const lookupKey=post.id+'|'+signature;
  const hasMedia=post.availability==='available'&&(post.media.some(kind=>kind==='Image'||kind==='Video')||hasExternalAttachment(post));
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
    const observer=new IntersectionObserver(entries=>{setVisible(entries.some(entry=>entry.isIntersecting));});
    observer.observe(ref.current);return()=>observer.disconnect();
  },[post.id,hasMedia]);
  const polling=visible&&syncing,localRevision=visible?revision:0;
  useEffect(()=>{
    if((!visible&&!eager)||!hasMedia)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    async function poll(){
      try{
        const response=await fetch('/api/media/'+post.id),value:{items:MediaItem[];sync:MediaSyncState|null}=await response.json();
        if(!response.ok)throw new Error('Could not load local media status');if(disposed)return;setItems(value.items);setSync(value.sync);setLoadedKey(lookupKey);setError(null);
      }catch(e){if(!disposed)setError({key:lookupKey,message:(e as Error).message});}
      if(!disposed&&polling)timer=setTimeout(()=>void poll(),1000);
    }
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[visible,eager,hasMedia,polling,post.id,signature,localRevision]);
  const checked=loadedKey===lookupKey,localError=error?.key===lookupKey?error.message:'';
  const readyAll=hasMedia&&checked?items.filter(item=>item.state==='ready'):[];
  const visibleItems=items.filter(item=>!filter||item.kind===filter);
  const ready=readyAll.filter(item=>!filter||item.kind===filter);
  const notDownloaded=hasMedia&&checked&&!localError&&(!post.mediaDiscoveryComplete||readyAll.length<Math.max(items.length,1)||hasExternalAttachment(post)||sync?.status==='unavailable'||sync?.status==='failed');
  const note=localError||(!checked?'Checking local media…':sync?.status==='downloading'?'Downloading media during sync…':
    sync?.status==='unavailable'?(sync.reason??'This media cannot be saved offline'):
    sync?.status==='failed'?`Download failed · Sync this feed again to retry. ${sync.reason??''}`:!post.mediaDiscoveryComplete?'Collection discovery is incomplete · Sync this feed to collect every file':
    syncing?'Media queued for this sync':'Awaiting sync · Sync this feed to save it offline');
  const slides=ready.map((item,index)=>({id:post.id+':'+item.key+':'+index,kind:item.kind,url:item.url!,title:item.kind==='image'&&ready.length>1?`${post.title} — image ${index+1}`:post.title,caption:item.caption}));
  const slideSignature=JSON.stringify(slides);
  useEffect(()=>browsing?.register(scope,post.id,slides),[browsing,scope,post.id,slideSignature]);
  const paths=ready.flatMap(item=>item.localPath?[item.localPath]:[]);
  const embed=filter!=='image'&&notDownloaded&&(readyAll.length===0||hasExternalAttachment(post))&&post.media.includes('Video')?onlineEmbed(post.outbound):null;
  let original:string|null=null;
  const external=post.outbound??(hasExternalAttachment(post)?post.permalink:null);
  if(notDownloaded&&(embed||!post.attachments.length||hasExternalAttachment(post))&&external){
    try{const url=new URL(external);if(embed&&url.protocol==='http:')url.protocol='https:';if(url.protocol==='https:'&&!url.username&&!url.password)original=url.href;}catch{/* Invalid external links are not rendered. */}
  }
  const copyLocalPath=paths.length>0?<button type="button" className="copy-local-path" title={paths.join('\n')} aria-live="polite" onClick={()=>void copyPaths(paths)}>{copyStatus}</button>:null;
  const controls=<>{post.bodySync&&post.bodySync.status!=='ready'&&<span className="media-offline-status" title={post.bodySync.reason??'Sync this feed to save the complete post text'}>{post.body!==null?'Text update pending':'Text not downloaded'}</span>}{notDownloaded&&<span className="media-offline-status" role="status" title={note}>{ready.length?'Partially downloaded':'Not downloaded'}</span>}{localError&&hasMedia&&<span className="media-status-unknown" title={localError}>Status unknown</span>}{copyLocalPath}</>;
  return <>{children?.(controls)}{hasMedia&&<div className="post-media" ref={ref} data-read-pending={!checked}>
    {(visibleItems.length>1||!post.mediaDiscoveryComplete)&&<p className="media-note">{post.mediaDiscoveryComplete?`${ready.length}/${visibleItems.length} files saved offline`:`${ready.length} files saved · Collection not fully discovered`}{ready.length>1?' · Scroll horizontally to view all':''}</p>}
    {ready.length>0&&<div className={'media-items '+(ready.length>1?'gallery':'')} role="group" aria-label={`${ready.length} saved media files`} tabIndex={ready.length>1?0:undefined}>{ready.map((item,index)=><figure key={item.key+':'+index}><MediaPreview slideId={slides[index]!.id} sequence={()=>browsing?.slides(scope)??slides} kind={item.kind} url={item.url!} title={item.kind==='image'&&ready.length>1?`${post.title} — image ${index+1}`:post.title} caption={item.caption}/>{item.caption&&<figcaption>{item.caption}</figcaption>}</figure>)}</div>}
    {embed&&<div className="online-media"><p className="media-note">{offline?'Offline mode · Online player paused':'Online player · Requires internet · Not saved locally'}</p>{!offline&&<iframe key={embed.url} src={'/online-player?url='+encodeURIComponent(embed.url)} title={`${embed.provider} player: ${post.title}`} loading="lazy" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen/>}</div>}
    {(!checked||localError||notDownloaded)&&<p className="media-note">{note}{original&&<ExternalLink href={original} target="_blank" rel="noreferrer" title="Requires internet; this media is not stored locally">Open original ↗</ExternalLink>}</p>}
  </div>}</>;
}
