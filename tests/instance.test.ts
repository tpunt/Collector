import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,rename,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimInstance,InstanceBusyError,readInstance} from '../src/instance.ts';
import {assertRuntime,launchPort} from '../src/launcher.ts';

test('a library has one lease; publication, release, stale recovery and checkout identity preserve ownership',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector instance ')),database=join(root,'reader.sqlite');
 try{
  const lease=claimInstance(database,root)!;assert.equal(readInstance(database)?.pid,process.pid);assert.equal((await stat(join(root,'.collector-instance.json'))).mode&0o777,0o600);
  assert.throws(()=>claimInstance(database,root),InstanceBusyError);lease.publish('http://127.0.0.1:3210');assert.equal(readInstance(database)?.origin,'http://127.0.0.1:3210');lease.release();assert.equal(readInstance(database),null);
  const stale={...lease.record,pid:2147483647};await writeFile(join(root,'.collector-instance.json'),JSON.stringify(stale));const replacement=claimInstance(database,root)!;assert.notEqual(replacement.record.id,stale.id);lease.release();assert.equal(readInstance(database)?.id,replacement.record.id);replacement.release();
  await writeFile(join(root,'.collector-instance.json'),'{broken');assert.throws(()=>claimInstance(database,root),/Cannot read/);assert.equal(await readFile(join(root,'.collector-instance.json'),'utf8'),'{broken');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('launcher validates runtime and explicit ports before serving',()=>{
 for(const version of ['24.9.0','25.2.9','20.19.0'])assert.throws(()=>assertRuntime(version),/Node 25.3/);
 for(const version of ['25.3.0','25.9.1','26.0.0'])assert.doesNotThrow(()=>assertRuntime(version));
 assert.deepEqual(launchPort(undefined),{port:3210,fallback:true});assert.deepEqual(launchPort('3211'),{port:3211,fallback:false});
 for(const value of ['0','65536','abc','-1','2.5'])assert.throws(()=>launchPort(value),/PORT/);
});


test('a moved library replaces valid stale paths after acquiring its OS lock',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-moved-')),old=join(directory,'old'),moved=join(directory,'moved');await(await import('node:fs/promises')).mkdir(old);
 const original=claimInstance(join(old,'reader.sqlite'),old)!;const record={...original.record};original.release();await writeFile(join(old,'.collector-instance.json'),JSON.stringify(record));await rename(old,moved);
 try{const lease=claimInstance(join(moved,'reader.sqlite'),moved)!;assert.notEqual(lease.record.id,record.id);assert.equal(lease.record.database,join(await realpath(moved),'reader.sqlite'));lease.release();assert.equal(readInstance(join(moved,'reader.sqlite')),null);}finally{await rm(directory,{recursive:true,force:true});}
});
