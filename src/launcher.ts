import {spawn,spawnSync} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataDirectory} from './paths.ts';
import {InstanceBusyError,processAlive,readInstance} from './instance.ts';
import type {InstanceRecord} from './instance.ts';

const checkout=resolve(import.meta.dirname,'..');
export function assertRuntime(version=process.versions.node){const [major,minor]=version.split('.').map(Number);if(major<25||(major===25&&minor<3))throw new Error('Collector needs Node 25.3 or newer. Run nvm install && nvm use in this checkout.');}
export function launchPort(value=process.env.PORT){if(value===undefined)return{port:3210,fallback:true};if(!/^\d+$/.test(value)||Number(value)<1||Number(value)>65535)throw new Error('PORT must be an integer between 1 and 65535');return{port:Number(value),fallback:false};}
async function probe(record:InstanceRecord,root:string){
  if(record.root!==root)throw new Error('This library is open from another checkout: '+record.root+'. Quit that instance before sharing its data here.');
  const deadline=Date.now()+15_000;
  do{
    const current=readInstance(record.database);
    if(!current||current.id!==record.id||!processAlive(current.pid))throw new Error('The running instance stopped during launch. Launch Collector again.');
    if(current.origin){
      try{
        const response=await fetch(current.origin+'/api/instance',{signal:AbortSignal.timeout(1500),redirect:'error'});
        const value=await response.json();
        if(response.ok&&value.id===current.id&&value.database===current.database&&value.root===root)return current.origin;
      }catch{/* A starting instance can publish its address before it is ready. */}
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()<deadline);
  throw new Error('The existing Collector instance is not responding. Quit its terminal before relaunching.');
}
function command(binary:string,args:string[],cwd:string){return new Promise<void>((resolve,reject)=>{const child=spawn(binary,args,{cwd,stdio:'inherit'});child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error('Command failed'+(signal?' ('+signal+')':': exit '+code))));});}
function buildUI(){const require=createRequire(import.meta.url);let vite:string;try{vite=join(dirname(require.resolve('vite/package.json')),'bin','vite.js');}catch{throw new Error('Dependencies are missing. Run npm ci in '+checkout+' first.');}return command(process.execPath,[vite,'build'],checkout);}
function openBrowser(origin:string){if(process.platform!=='darwin')return Promise.resolve();return command('/usr/bin/open',[origin],checkout);}
export function collectionWarnings(){
  const warnings:string[]=[];
  if(process.platform==='darwin'&&(process.env.REDDIT_READER_BROWSER_CHANNEL??'chrome')==='chrome'&&!['/Applications/Google Chrome.app',join(process.env.HOME??'','Applications/Google Chrome.app')].some(existsSync))warnings.push('Google Chrome is missing. Offline reading works; install Chrome before syncing.');
  const ffmpeg=spawnSync('ffmpeg',['-version'],{stdio:'ignore',timeout:3000});
  if(ffmpeg.error||ffmpeg.status!==0)warnings.push('FFmpeg is missing. Offline reading works; install FFmpeg before syncing videos with separate audio.');
  return warnings;
}
export async function launchCollector(options:{directory?:string;root?:string;port?:number;fallback?:boolean;build?:()=>Promise<void>;openBrowser?:(origin:string)=>Promise<void>}={}){
  assertRuntime();const root=realpathSync(options.root??checkout),directory=resolve(options.directory??dataDirectory),database=join(directory,'reader.sqlite');
  const open=options.openBrowser??openBrowser;
  const reuse=async(record:InstanceRecord)=>{const origin=await probe(record,root);await open(origin);return{origin,reused:true,stop:async()=>{},closed:Promise.resolve()};};
  // Import only after checking runtime/dependencies so Finder launches get an
  // actionable error instead of a loader stack trace.
  let createReaderServer:typeof import('./server.ts').createReaderServer;
  try{({createReaderServer}=await import('./server.ts'));}catch(error){if((error as NodeJS.ErrnoException).code==='ERR_MODULE_NOT_FOUND')throw new Error('Dependencies are missing. Run npm ci in '+root+' first.');throw error;}
  let finish!:()=>void,closing:Promise<void>|null=null;
  const closed=new Promise<void>(resolve=>{finish=resolve;});
  const stop=()=>closing??=app.close().finally(finish);
  let app:ReturnType<typeof createReaderServer>;
  try{app=createReaderServer({database,root,onShutdown:stop});}catch(error){if(error instanceof InstanceBusyError)return reuse(error.record);throw error;}
  try{
    await(options.build??buildUI)();
    const defaults=options.port===undefined?launchPort():{port:options.port,fallback:options.fallback??false};
    let origin:string;
    try{origin=await app.listen(defaults.port);}catch(error){if(!defaults.fallback||(error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;origin=await app.listen(0);}
    await open(origin);
    return{origin,reused:false,stop,closed};
  }catch(error){await stop();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const app=await launchCollector();console.log(`Collector: ${app.origin}${app.reused?' (already running)':''}`);
    if(!app.reused){for(const warning of collectionWarnings())console.log(warning);const stop=()=>void app.stop().catch(error=>{console.error(error.message);process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);await app.closed;process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  }catch(error){console.error('Collector could not start: '+(error as Error).message);process.exitCode=1;}
}
