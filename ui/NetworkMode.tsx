import React,{createContext,useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {NetworkStatus} from '../src/network-mode.ts';

type Mode={offline:boolean;connected:boolean;status:NetworkStatus|null;beginOffline:()=>void};
const Context=createContext<Mode>({offline:true,connected:false,status:null,beginOffline:()=>{}});
export const NetworkModeProvider=Context.Provider;
export const useNetworkMode=()=>useContext(Context);

export function useNetworkController(token:string,stopped:boolean):Mode{
  const [client]=useState(()=>crypto.randomUUID()),[status,setStatus]=useState<NetworkStatus|null>(null),[connected,setConnected]=useState(false),[forced,setForced]=useState(false);
  const revision=useRef(0),channel=useRef<BroadcastChannel|null>(null),socket=useRef<WebSocket|null>(null);
  useEffect(()=>{
    const broadcast=new BroadcastChannel('collector-offline-mode');channel.current=broadcast;
    broadcast.onmessage=event=>{if(event.data?.offline===true&&event.data.revision>=revision.current)setForced(true);};
    return()=>{broadcast.close();channel.current=null;};
  },[]);
  useEffect(()=>{
    if(!token||stopped)return;
    let closed=false,retry:ReturnType<typeof setTimeout>|undefined;
    const connect=()=>{
      const url=new URL('/api/network/events',location.href);url.protocol='ws:';url.searchParams.set('client',client);url.searchParams.set('token',token);
      const events=new WebSocket(url);socket.current=events;
      events.onmessage=event=>{
        if(closed||socket.current!==events)return;
        const value=JSON.parse(event.data) as NetworkStatus;
        if(value.revision>=revision.current){if(value.revision>revision.current)setForced(false);revision.current=value.revision;setStatus(value);setConnected(true);}
      };
      events.onerror=()=>{if(!closed&&socket.current===events)setConnected(false);};
      events.onclose=()=>{if(!closed&&socket.current===events){setConnected(false);retry=setTimeout(connect,1500);}};
    };connect();
    return()=>{closed=true;clearTimeout(retry);socket.current?.close();socket.current=null;setConnected(false);};
  },[token,client,stopped]);
  const offline=forced||!connected||status?.offline!==false;
  // The server confirms Offline mode only after mounted players have been removed.
  useLayoutEffect(()=>{
    if(!connected||!status?.offline||!token)return;
    if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({revision:status.revision}));
  },[connected,status?.revision,status?.offline,token,client]);
  return{offline,connected,status,beginOffline:()=>{setForced(true);channel.current?.postMessage({offline:true,revision:revision.current});}};
}

export function ExternalLink({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>){
  const {offline}=useNetworkMode();
  return offline?<span className="external-link-disabled" aria-disabled="true" title="External links are disabled in Offline mode">{children}</span>:<a {...props}>{children}</a>;
}
