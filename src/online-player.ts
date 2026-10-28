import {randomBytes} from 'node:crypto';
import {onlineEmbed} from './online-embed.ts';

/** A local, policy-controlled frame owns every external player, including standalone tabs. */
export function onlinePlayer(input:string,token:string,origin:string){
  const embed=onlineEmbed(input);if(!embed)throw new Error('Unsupported online player');
  const nonce=randomBytes(16).toString('base64');
  const csp=`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self' ${origin.replace(/^http:/,'ws:')}; frame-src ${new URL(embed.url).origin}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`;
  const body=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#101416;color:#aebcc5;font:12px system-ui}iframe{width:100%;height:100%;border:0}p{padding:12px;margin:0}</style></head><body><p id="message">Connecting to local player permissions…</p><script nonce="${nonce}">
const client=crypto.randomUUID(),token=${JSON.stringify(token)},url=${JSON.stringify(embed.url)},message=document.getElementById('message');let frame=null;
const pause=()=>{if(frame){frame.remove();frame=null;}message.hidden=false;message.textContent='Offline mode: online player paused.';};
let events=null,closed=false,retry=null;const connect=()=>{const endpoint=new URL('/api/network/events',location.href);endpoint.protocol='ws:';endpoint.searchParams.set('client',client);endpoint.searchParams.set('token',token);events=new WebSocket(endpoint);
events.onmessage=event=>{const status=JSON.parse(event.data);if(status.offline){pause();events.send(JSON.stringify({revision:status.revision}));}else if(!frame){message.hidden=true;frame=document.createElement('iframe');frame.title='Online video player';frame.referrerPolicy='strict-origin-when-cross-origin';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-presentation');frame.allow='encrypted-media; fullscreen; picture-in-picture';frame.allowFullscreen=true;frame.src=url;document.body.append(frame);}};
events.onerror=pause;events.onclose=()=>{pause();if(!closed)retry=setTimeout(connect,1500);};};connect();addEventListener('pagehide',()=>{closed=true;clearTimeout(retry);pause();events.close();});
</script></body></html>`;
  return{body,csp};
}
