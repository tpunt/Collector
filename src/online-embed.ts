export interface OnlineEmbed { provider:'YouTube'|'Vimeo'; url:string }

/** Build a player URL from a known provider's video link, never supplied HTML.
 * This describes online playback only; it is not an offline media reference. */
export function onlineEmbed(input:string|null|undefined):OnlineEmbed|null {
  try{
    if(!input||input.length>4000)return null;
    const source=new URL(input);
    if(!['https:','http:'].includes(source.protocol)||source.username||source.password||source.port)return null;
    let id:string|undefined;
    if(['youtube.com','www.youtube.com','m.youtube.com'].includes(source.hostname)){
      id=source.pathname==='/watch'?source.searchParams.get('v')??undefined:source.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)\/?$/)?.[1];
    }else if(source.hostname==='youtu.be'){
      id=source.pathname.match(/^\/([\w-]+)\/?$/)?.[1];
    }else if(['youtube-nocookie.com','www.youtube-nocookie.com'].includes(source.hostname)){
      id=source.pathname.match(/^\/embed\/([\w-]+)\/?$/)?.[1];
    }
    if(id&&/^[\w-]{1,128}$/.test(id)){
      return {provider:'YouTube',url:`https://www.youtube-nocookie.com/embed/${id}?autoplay=0&playsinline=1`};
    }
    if(['vimeo.com','www.vimeo.com','player.vimeo.com'].includes(source.hostname)){
      const match=source.pathname.match(/^\/(?:video\/)?(\d{1,20})(?:\/([a-zA-Z0-9]{1,128}))?\/?$/);
      if(!match)return null;
      const hash=source.searchParams.get('h')??match[2];
      if(hash!==undefined&&!/^[a-zA-Z0-9]{1,128}$/.test(hash))return null;
      const player=new URL(`https://player.vimeo.com/video/${match[1]}`);
      if(hash)player.searchParams.set('h',hash);
      player.searchParams.set('autoplay','0');
      return {provider:'Vimeo',url:player.href};
    }
  }catch{/* Invalid or unsupported links remain ordinary outbound links. */}
  return null;
}
