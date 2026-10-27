import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync,readFileSync,realpathSync,unlinkSync,renameSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

export interface InstanceRecord {pid:number;id:string;root:string;database:string;origin:string|null}
export class InstanceBusyError extends Error {
  record:InstanceRecord;
  constructor(record:InstanceRecord){super(`This library is already open in process ${record.pid}${record.origin?' at '+record.origin:''}. Quit that instance before opening it here.`);this.record=record;}
}
const canonical=(database:string)=>join(realpathSync(dirname(resolve(database))),basename(database));
const recordPath=(database:string)=>join(dirname(resolve(database)),'.collector-instance.json');
export function processAlive(pid:number){try{process.kill(pid,0);return true;}catch(error){return(error as NodeJS.ErrnoException).code!=='ESRCH';}}
export function readInstance(database:string):InstanceRecord|null {
  const path=recordPath(database);if(!existsSync(path))return null;
  let value:InstanceRecord;
  try{value=JSON.parse(readFileSync(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Cannot read the library instance record. Check that no Collector is running before removing '+path);}
  if(!value||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.id!=='string'||typeof value.root!=='string'||typeof value.database!=='string'||canonical(value.database)!==canonical(database)||(value.origin!==null&&(typeof value.origin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value.origin)||Number(new URL(value.origin).port)>65535)))throw new Error('Invalid library instance record: '+path);
  return value;
}
export function claimInstance(database:string,root:string){
  if(database===':memory:')return null;
  const canonicalRoot=realpathSync(root);
  const path=recordPath(database);mkdirSync(dirname(path),{recursive:true,mode:0o700});
  // Keep an EXCLUSIVE OS lock on a separate coordination database.
  // SQLite's OS file lock survives concurrent startup races and is released by
  // process death. Never delete this file while the library may be in use.
  const lock=new DatabaseSync(join(dirname(path),'.collector-lock.sqlite'),{timeout:0});
  try{lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');}catch(error){
    lock.close();
    if((error as {errcode?:number}).errcode!==5)throw error;
    const existing=readInstance(database);if(existing)throw new InstanceBusyError(existing);
    throw new Error('Another Collector is starting or stopping this library. Try launching again.');
  }
  let released=false;
  const record:InstanceRecord={pid:process.pid,id:randomUUID(),root:canonicalRoot,database:canonical(database),origin:null};
  const publish=()=>{const temporary=path+'.'+record.id;writeFileSync(temporary,JSON.stringify(record),{mode:0o600});renameSync(temporary,path);};
  try{
    // Preserve an unreadable record for diagnosis instead of guessing ownership.
    readInstance(database);
    // Older Collectors predate the lock. Scope lsof strictly to this database;
    // it never reads content or process arguments.
    if(process.platform==='darwin'&&existsSync(database)){
      const probe=spawnSync('/usr/sbin/lsof',['-nP','-t','--',resolve(database)],{encoding:'utf8',timeout:10_000});
      if(probe.error||(probe.status!==0&&probe.status!==1))throw new Error('Unable to check whether this library is already open'+(probe.error?': '+probe.error.message:''));
      if((probe.stdout??'').trim().split(/\s+/).some(pid=>Number(pid)>0&&Number(pid)!==process.pid))throw new Error('This database is already open by another process. Stop the older app before relaunching.');
    }
    lock.exec('PRAGMA user_version=1; COMMIT');
    // locking_mode=EXCLUSIVE retains the OS lock across this commit, leaving
    // no unlocked handoff between processes.
    publish();
    return{record,publish(origin:string){record.origin=origin;publish();},release(){if(released)return;released=true;try{if(readInstance(database)?.id===record.id)unlinkSync(path);}finally{lock.close();}}};
  }catch(error){lock.close();throw error;}
}
