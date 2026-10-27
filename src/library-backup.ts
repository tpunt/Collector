import {Encrypter,Decrypter} from 'age-encryption';
import tar from 'tar-stream';
import {Readable,Transform} from 'node:stream';
import type {ReadableStream as NodeReadableStream} from 'node:stream/web';
import {pipeline} from 'node:stream/promises';
import {createReadStream,createWriteStream,existsSync,readFileSync,writeFileSync,renameSync,copyFileSync,rmSync} from 'node:fs';
import {mkdir,mkdtemp,rm,stat,readFile,chmod,rename} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ReaderStore} from './store.ts';
import type {MediaCache} from './media.ts';
import {SCHEMA_VERSION} from './schema.ts';

const MAX_MANIFEST=32*1024*1024;
const fileName=/^(reader\.sqlite|media\/[a-f0-9]{64}(\.json)?)$/;
interface BackupFile {name:string;bytes:number;sha256:string}
interface Manifest {format:'Collector';version:1;schema:number;files:BackupFile[]}
export interface BackupPreview {id:string;posts:number;files:number;bytes:number}
interface Prepared extends BackupPreview {directory:string;expires:number}
const nodeStream=(stream:ReadableStream<Uint8Array>)=>Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>);

function password(value:unknown,creating=false):string {
  if(typeof value!=='string'||value.length<(creating?12:1)||value.length>1024)throw new Error(creating?'Use a backup passphrase of 12–1024 characters':'Enter the backup passphrase');
  return value;
}
async function digest(path:string,signal?:AbortSignal){const hash=createHash('sha256');for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);return hash.digest('hex');}
function journal(directory:string,stage:string,committed:boolean){
  const path=join(directory,'restore.json');writeFileSync(path+'.tmp',JSON.stringify({stage:basename(stage),committed}),{mode:0o600,flush:true});renameSync(path+'.tmp',path);
}

/** Runs before opening SQLite. An unacknowledged replacement always rolls back. */
export function recoverLibraryRestore(database:string,mediaDirectory:string,directory:string){
  const path=join(directory,'restore.json');if(database===':memory:'||!existsSync(path))return;
  const marker=JSON.parse(readFileSync(path,'utf8'));
  if(!/^stage-[a-z0-9]+$/i.test(marker.stage)||typeof marker.committed!=='boolean')throw new Error('Invalid restore recovery marker; preserve the backup work directory');
  const stage=join(directory,marker.stage);
  if(!marker.committed){
    if(!existsSync(join(stage,'previous.sqlite')))throw new Error('Restore rollback database is missing; preserve the backup work directory');
    copyFileSync(join(stage,'previous.sqlite'),database);
    for(const suffix of ['-wal','-shm'])rmSync(database+suffix,{force:true});
    if(existsSync(join(stage,'previous-media'))){rmSync(mediaDirectory,{recursive:true,force:true});renameSync(join(stage,'previous-media'),mediaDirectory);}
  }
  rmSync(path,{force:true});rmSync(stage,{recursive:true,force:true});
}

/** age handles all cryptography; TAR is just a bounded, strictly named payload. */
export class LibraryBackups {
  recoveryRequired=false;
  private prepared=new Map<string,Prepared>();
  private downloads=new Map<string,{directory:string;path:string;bytes:number;expires:number}>();
  private pending=new Set<Promise<unknown>>();
  private controller=new AbortController();
  private expiry:ReturnType<typeof setInterval>;
  private store:ReaderStore;private media:MediaCache;private directory:string;private mediaDirectory:string;private workFactor:number;
  constructor(store:ReaderStore,media:MediaCache,directory:string,mediaDirectory:string,workFactor=18){
    if(!Number.isInteger(workFactor)||workFactor<1||workFactor>18)throw new Error('Invalid backup encryption work factor');
    this.store=store;this.media=media;this.directory=directory;this.mediaDirectory=mediaDirectory;this.workFactor=workFactor;
    this.expiry=setInterval(()=>void this.expire().catch(()=>{}),60_000);this.expiry.unref();
  }
  private async task<T>(run:()=>Promise<T>):Promise<T>{const promise=run();this.pending.add(promise);try{return await promise;}finally{this.pending.delete(promise);}}
  private async stage(){await mkdir(this.directory,{recursive:true,mode:0o700});return await mkdtemp(join(this.directory,'stage-'));}
  async create(passphrase:unknown,clientSignal?:AbortSignal):Promise<{id:string;bytes:number}>{return this.task(async()=>{
    const signal=clientSignal?AbortSignal.any([clientSignal,this.controller.signal]):this.controller.signal;
    const secret=password(passphrase,true),directory=await this.stage(),snapshot=join(directory,'reader.sqlite'),output=join(directory,'backup.age');
    try{
      await this.store.snapshot(snapshot);await chmod(snapshot,0o600);
      signal.throwIfAborted();
      const files:BackupFile[]=[];
      for(const name of ['reader.sqlite',...(await this.media.backupFiles()).map(name=>'media/'+name)]){
        const path=name==='reader.sqlite'?snapshot:join(this.mediaDirectory,basename(name));
        files.push({name,bytes:(await stat(path)).size,sha256:await digest(path,signal)});
      }
      const manifest=Buffer.from(JSON.stringify({format:'Collector',version:1,schema:SCHEMA_VERSION,files} satisfies Manifest));
      if(manifest.length>MAX_MANIFEST)throw new Error('The backup file index exceeds its parser safety bound');
      const pack=tar.pack();const produce=(async()=>{
        await new Promise<void>((resolve,reject)=>pack.entry({name:'manifest.json',size:manifest.length,mode:0o600},manifest,error=>error?reject(error):resolve()));
        for(const file of files)await pipeline(createReadStream(file.name==='reader.sqlite'?snapshot:join(this.mediaDirectory,basename(file.name))),pack.entry({name:file.name,size:file.bytes,mode:0o600}),{signal});
        pack.finalize();
      })();
      const encrypted=new Encrypter();encrypted.setPassphrase(secret);encrypted.setScryptWorkFactor(this.workFactor);
      void produce.catch(()=>{});
      try{
        const stream=await encrypted.encrypt(Readable.toWeb(Readable.from(pack)) as ReadableStream<Uint8Array>);
        await Promise.all([produce,pipeline(nodeStream(stream),createWriteStream(output,{flags:'wx',mode:0o600}),{signal})]);
      }catch(error){pack.destroy(error as Error);await produce.catch(()=>{});throw error;}
      await rm(snapshot,{force:true});const bytes=(await stat(output)).size,id=randomUUID();
      this.downloads.set(id,{directory,path:output,bytes,expires:Date.now()+10*60_000});return{id,bytes};
    }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  });}
  download(id:string){const file=this.downloads.get(id);if(!file||file.expires<Date.now())throw new Error('Backup download expired; create another backup');return file;}
  async prepare(input:Readable,passphrase:unknown):Promise<BackupPreview>{return this.task(async()=>{
    const secret=password(passphrase),directory=await this.stage();await mkdir(join(directory,'media'),{mode:0o700});
    const source=Readable.from(input.iterator({destroyOnReturn:false}));
    let guard:Transform|undefined,decoded:Readable|undefined,parser:ReturnType<typeof tar.extract>|undefined;
    let forwarded:Promise<void>|undefined,unpacked:Promise<void>|undefined;
    const entries=new Set<Promise<void>>();
    try{
      let header=Buffer.alloc(0),checked=false,uploaded=0;
      guard=new Transform({transform:(chunk:Buffer,_encoding,callback)=>{
        uploaded+=chunk.length;if(uploaded>this.store.storageLimit*1.1+MAX_MANIFEST*16)return callback(new Error('Backup exceeds the current storage cap; increase it before restoring'));
        if(checked)return callback(null,chunk);
        header=Buffer.concat([header,chunk]);const end=header.indexOf('\n--- ');
        if(end<0){if(header.length>4096)return callback(new Error('Invalid or oversized age header'));return callback();}
        const text=header.subarray(0,end).toString('ascii'),factor=/\n-> scrypt [A-Za-z0-9+/]+ ([1-9][0-9]*)\n/.exec(text);
        if(end>4096||!text.startsWith('age-encryption.org/v1\n')||!factor||Number(factor[1])>18)return callback(new Error('This is not a supported password-encrypted Collector backup'));
        checked=true;callback(null,header);header=Buffer.alloc(0);
      },flush:callback=>callback(checked?undefined:new Error('Incomplete age header'))});
      // Attach forwarding before KDF/header processing. Never leave an input
      // error or client disconnect without a consumer/rejection handler.
      forwarded=pipeline(source,guard,{signal:this.controller.signal});void forwarded.catch(()=>{});
      const decryptor=new Decrypter();decryptor.addPassphrase(secret);
      const plain=await decryptor.decrypt(Readable.toWeb(guard) as ReadableStream<Uint8Array>);
      const extract=tar.extract();parser=extract;let manifest:Manifest|undefined;const accepted=new Set<string>(),index=new Map<string,BackupFile>();
      extract.on('entry',(entry,stream,next)=>{const task=(async()=>{
        if(entry.type!=='file')throw new Error('Backup contains a non-file TAR entry');
        if(!manifest){
          if(entry.name!=='manifest.json'||entry.size>MAX_MANIFEST)throw new Error('Backup must start with its bounded manifest');
          const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk as Uint8Array));manifest=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(manifest?.format!=='Collector'||manifest.version!==1||![3,SCHEMA_VERSION].includes(manifest.schema)||!Array.isArray(manifest.files))throw new Error('Unsupported Collector backup format');
          const names=new Set<string>();let bytes=0;
          for(const file of manifest.files){if(!fileName.test(file.name)||names.has(file.name)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid backup file index');names.add(file.name);index.set(file.name,file);bytes+=file.bytes;}
          if(!names.has('reader.sqlite'))throw new Error('Backup database is missing');
          if(!Number.isSafeInteger(bytes))throw new Error('Invalid backup size');
          if(bytes>this.store.storageLimit)throw new Error('Backup exceeds the current storage cap; increase it before restoring');
        }else{
          const file=index.get(entry.name);
          if(!file||accepted.has(entry.name)||entry.size!==file.bytes)throw new Error('Unexpected, duplicate or incorrectly sized backup file');
          const target=join(directory,file.name);await pipeline(stream,createWriteStream(target,{flags:'wx',mode:0o600}));
          if(await digest(target)!==file.sha256)throw new Error('Backup file checksum failed');accepted.add(entry.name);
        }
      })();entries.add(task);void task.then(()=>next(),error=>extract.destroy(error as Error)).finally(()=>entries.delete(task));});
      decoded=nodeStream(plain);unpacked=pipeline(decoded,extract,{signal:this.controller.signal});
      await Promise.all([forwarded,unpacked]);
      // Both the archive and age's authenticated final chunk must finish before
      // staged content can become visible or receive a confirmation ticket.
      if(!manifest||accepted.size!==manifest.files.length)throw new Error('Backup is incomplete');
      const validated=this.store.validateBackup(join(directory,'reader.sqlite'),true);
      if(validated.schema!==manifest.schema)throw new Error('Backup database version does not match its manifest');
      if(validated.schema!==SCHEMA_VERSION){
        // Published backups are upgraded only after authentication and validation,
        // inside staging. The live library remains untouched until confirmation.
        const upgraded=new ReaderStore(join(directory,'reader.sqlite'));upgraded.close();
        this.store.validateBackup(join(directory,'reader.sqlite'));
      }
      for(const file of manifest.files.filter(file=>file.name.startsWith('media/'))){
        if(!file.name.endsWith('.json')&&file.bytes===0)throw new Error('Backup contains an empty media file');
        const key=basename(file.name).replace(/\.json$/,'');
        if(!validated.keys.has(key)||!accepted.has('media/'+key)||!accepted.has('media/'+key+'.json'))throw new Error('Backup media ownership or metadata is incomplete');
        if(file.name.endsWith('.json')){
          if(file.bytes>4096)throw new Error('Invalid media metadata');const data=JSON.parse(await readFile(join(directory,file.name),'utf8'));
          const owned=index.get('media/'+key)!;
          if(data.key!==key||data.bytes!==owned.bytes||!/^image\/(jpeg|png|gif|webp|avif)$|^video\/(mp4|webm)$/.test(data.type))throw new Error('Invalid media metadata');
        }
      }
      const bytes=manifest.files.filter(file=>file.name!=='reader.sqlite').reduce((sum,file)=>sum+file.bytes,0)+(await stat(join(directory,'reader.sqlite'))).size;
      if(bytes>this.store.storageLimit)throw new Error('Upgraded backup exceeds the current storage cap; increase it before restoring');
      const value={id:randomUUID(),directory,expires:Date.now()+10*60_000,posts:validated.posts,files:manifest.files.filter(file=>file.name.startsWith('media/')&&!file.name.endsWith('.json')).length,bytes};
      for(const old of this.prepared.values())await rm(old.directory,{recursive:true,force:true});this.prepared.clear();this.prepared.set(value.id,value);
      return{id:value.id,posts:value.posts,files:value.files,bytes:value.bytes};
    }catch(error){
      source.destroy();guard?.destroy();decoded?.destroy();parser?.destroy();
      await Promise.allSettled([forwarded,unpacked,...entries].filter((item):item is Promise<void>=>Boolean(item)));
      input.resume();await rm(directory,{recursive:true,force:true});
      if(error instanceof Error&&/identity matched|HMAC|ciphertext|authentication|invalid tag|final chunk|decryption failed/i.test(error.message))throw new Error('Could not decrypt this backup. Check the passphrase and file integrity.');
      throw error;
    }
  });}
  async restore(id:string):Promise<void>{return this.task(async()=>{
    const prepared=this.prepared.get(id);if(!prepared||prepared.expires<Date.now())throw new Error('Validate a backup before confirming replacement');
    if(prepared.bytes>this.store.storageLimit)throw new Error('Backup exceeds the current storage cap; increase it before restoring');
    // A publication in progress must not expire and delete its rollback files.
    prepared.expires=Infinity;
    const stage=prepared.directory;
    try{await this.store.snapshot(join(stage,'previous.sqlite'));await chmod(join(stage,'previous.sqlite'),0o600);journal(this.directory,stage,false);}
    catch(error){prepared.expires=Date.now()+10*60_000;throw error;}
    this.prepared.delete(id);
    try{
      await rename(this.mediaDirectory,join(stage,'previous-media'));await rename(join(stage,'media'),this.mediaDirectory);
      this.store.replaceFrom(join(stage,'reader.sqlite'));await this.media.reload();journal(this.directory,stage,true);
    }catch(error){
      try{
        this.store.replaceFrom(join(stage,'previous.sqlite'),false);
        if(existsSync(join(stage,'previous-media'))){await rm(this.mediaDirectory,{recursive:true,force:true});await rename(join(stage,'previous-media'),this.mediaDirectory);}
        await this.media.reload();rmSync(join(this.directory,'restore.json'),{force:true});
        this.prepared.delete(id);await rm(stage,{recursive:true,force:true});
      }catch{this.recoveryRequired=true;throw new Error('Restore recovery requires an application restart; library changes are blocked until recovery');}
      throw error;
    }
    this.prepared.delete(id);rmSync(join(this.directory,'restore.json'),{force:true});await rm(stage,{recursive:true,force:true});
  });}
  async discard(id:string){const value=this.prepared.get(id);if(value){this.prepared.delete(id);await rm(value.directory,{recursive:true,force:true});}}
  private async expire(){
    for(const [id,file] of this.downloads)if(file.expires<Date.now()){this.downloads.delete(id);await rm(file.directory,{recursive:true,force:true});}
    for(const [id,file] of this.prepared)if(file.expires<Date.now()){this.prepared.delete(id);await rm(file.directory,{recursive:true,force:true});}
  }
  async close(){clearInterval(this.expiry);this.controller.abort();await Promise.allSettled([...this.pending]);if(!existsSync(join(this.directory,'restore.json')))await rm(this.directory,{recursive:true,force:true});}
}
