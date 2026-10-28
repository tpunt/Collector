import React,{useEffect,useRef,useState} from 'react';

function Icon({name}:{name:'expand'|'play'|'pause'|'sound'|'muted'}){
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{name==='expand'?<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>:name==='play'?<path d="m8 4 12 8-12 8Z" fill="currentColor" stroke="none"/>:name==='pause'?<path d="M7 4v16M17 4v16" strokeWidth="4"/>:<><path d="M11 4 5 9H2v6h3l6 5Z"/>{name==='sound'?<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>:<path d="m16 9 6 6m0-6-6 6"/>}</>}</svg>;
}

/** Keep the same media element playing when entering or leaving full screen. */
export function MediaPreview({kind,url,title,caption}:{kind:'image'|'video';url:string;title:string;caption?:string}){
  const frame=useRef<HTMLDivElement>(null),native=useRef(false),returnFocus=useRef<HTMLElement|null>(null);
  const [expanded,setExpanded]=useState<{width:number;height:number}|null>(null);
  function close(){
    setExpanded(null);
    if(document.fullscreenElement===frame.current)void document.exitFullscreen().catch(()=>{});
  }
  async function expand(){
    const element=frame.current;if(!element)return;
    returnFocus.current=document.activeElement as HTMLElement|null;
    const {width,height}=element.getBoundingClientRect();setExpanded({width,height});
    // Embedded browsers may deny native full screen. The enlarged viewer still works.
    try{if(document.fullscreenEnabled&&element.requestFullscreen)await element.requestFullscreen();}catch{/* Use the viewport-sized viewer. */}
  }
  useEffect(()=>{
    const element=frame.current;
    const changed=()=>{if(document.fullscreenElement===element)native.current=true;else if(native.current){native.current=false;setExpanded(null);}};
    document.addEventListener('fullscreenchange',changed);
    return()=>{document.removeEventListener('fullscreenchange',changed);if(document.fullscreenElement===element)void document.exitFullscreen().catch(()=>{});};
  },[]);
  useEffect(()=>{
    if(!expanded)return;
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}};
    window.addEventListener('keydown',escape,true);
    frame.current?.querySelector<HTMLButtonElement>('.media-viewer-close')?.focus();
    return()=>{window.removeEventListener('keydown',escape,true);document.body.style.overflow=overflow;if(returnFocus.current?.isConnected)returnFocus.current.focus();};
  },[expanded]);
  function keys(event:React.KeyboardEvent<HTMLDivElement>){
    if(!expanded)return;
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){
      const targets=[...frame.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),video[tabindex="0"]')].filter(element=>element.tabIndex>=0&&element.getClientRects().length);
      const first=targets[0],last=targets.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }
  return <div className={'media-slot '+(kind==='video'?'has-video':'')} style={expanded?{width:expanded.width,height:expanded.height}:undefined}>
    <div ref={frame} className={'media-frame '+(expanded?'is-expanded':'')} data-media-expanded={Boolean(expanded)} role={expanded?'dialog':undefined} aria-modal={expanded?true:undefined} aria-label={expanded?`Full screen: ${title}`:undefined} onKeyDown={keys} onClick={event=>{if(expanded)event.stopPropagation();}}>
      {expanded&&<button type="button" className="media-viewer-close" aria-label="Close full screen" title="Close full screen (Esc)" onClick={close}>×</button>}
      {kind==='image'?<button type="button" className="media-image" aria-label={`View image full screen: ${title}`} tabIndex={expanded?-1:0} onClick={()=>{if(!expanded)void expand();}}><img src={url} alt={title} loading="lazy"/>{!expanded&&<span className="media-expand-icon"><Icon name="expand"/></span>}</button>:
        <LocalVideo url={url} title={title} expanded={Boolean(expanded)} toggleFullscreen={()=>expanded?close():void expand()}/>}
      {expanded&&caption&&<p className="media-viewer-caption">{caption}</p>}
    </div>
  </div>;
}

const time=(seconds:number)=>{const value=Math.max(0,Math.floor(seconds)),hours=Math.floor(value/3600),minutes=Math.floor(value/60)%60;return(hours?hours+':'+String(minutes).padStart(2,'0'):String(minutes))+':'+String(value%60).padStart(2,'0');};

function LocalVideo({url,title,expanded,toggleFullscreen}:{url:string;title:string;expanded:boolean;toggleFullscreen:()=>void}){
  const ref=useRef<HTMLVideoElement>(null);
  const [playing,setPlaying]=useState(false),[position,setPosition]=useState(0),[duration,setDuration]=useState(0),[volume,setVolume]=useState(1),[muted,setMuted]=useState(false),[error,setError]=useState('');
  async function togglePlay(){
    const video=ref.current;if(!video)return;
    setError('');if(!video.paused){video.pause();return;}
    try{await video.play();}catch(e){if((e as Error).name!=='AbortError')setError('Could not play this video. Try opening the local file.');}
  }
  function seek(value:number){const video=ref.current;if(video&&Number.isFinite(video.duration)){video.currentTime=Math.min(video.duration,Math.max(0,value));setPosition(video.currentTime);}}
  function volumeChanged(){setVolume(ref.current?.volume??1);setMuted(ref.current?.muted??false);}
  function toggleMute(){const video=ref.current;if(!video)return;if(video.muted||video.volume===0){video.muted=false;if(video.volume===0)video.volume=1;}else video.muted=true;volumeChanged();}
  function metadata(){const video=ref.current;if(video)setDuration(Number.isFinite(video.duration)?video.duration:0);}
  function keys(event:React.KeyboardEvent<HTMLVideoElement>){
    if(event.key===' '||event.key==='k'){event.preventDefault();void togglePlay();}
    else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();seek((ref.current?.currentTime??0)+(event.key==='ArrowLeft'?-5:5));}
    else if(event.key==='m'){event.preventDefault();toggleMute();}
    else if(event.key==='f'){event.preventDefault();toggleFullscreen();}
  }
  return <div className="local-video">
    <video ref={ref} src={url} preload="metadata" playsInline aria-label={title} tabIndex={0} onClick={()=>void togglePlay()} onKeyDown={keys} onLoadedMetadata={metadata} onDurationChange={metadata} onTimeUpdate={()=>setPosition(ref.current?.currentTime??0)} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onVolumeChange={volumeChanged} onError={()=>setError('Could not play this video. Try opening the local file.')}/>
    <div className="video-controls" role="group" aria-label={`Video controls: ${title}`}>
      <button type="button" aria-label={`${playing?'Pause':'Play'}: ${title}`} title={playing?'Pause (Space)':'Play (Space)'} onClick={()=>void togglePlay()}><Icon name={playing?'pause':'play'}/></button>
      <input className="video-position" type="range" min="0" max={duration} step="0.01" value={Math.min(position,duration)} disabled={!duration} aria-label={`Playback position: ${title}`} aria-valuetext={`${time(position)} of ${time(duration)}`} onChange={event=>seek(Number(event.target.value))}/>
      <span className="video-time">{time(position)} / {time(duration)}</span>
      <button type="button" aria-label={`${muted||volume===0?'Unmute':'Mute'}: ${title}`} title={muted||volume===0?'Unmute (M)':'Mute (M)'} onClick={toggleMute}><Icon name={muted||volume===0?'muted':'sound'}/></button>
      <input className="video-volume" type="range" min="0" max="1" step="0.05" value={muted?0:volume} aria-label={`Volume: ${title}`} onChange={event=>{const video=ref.current;if(video){video.volume=Number(event.target.value);video.muted=video.volume===0;volumeChanged();}}}/>
      <button type="button" aria-label={`${expanded?'Exit':'Enter'} full screen: ${title}`} title={expanded?'Exit full screen (Esc)':'Full screen (F)'} onClick={toggleFullscreen}><Icon name="expand"/></button>
    </div>
    {error&&<p className="media-playback-error" role="alert">{error}</p>}
  </div>;
}
