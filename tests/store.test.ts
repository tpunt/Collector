import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderStore, StaleGenerationError } from '../src/store.ts';
import type { PostObservation } from '../src/domain.ts';

function post(overrides: Partial<PostObservation> = {}): PostObservation {
  return {
    id: 't3_abc', subreddit: 'python', title: 'Test fixture', permalink: '/r/python/comments/abc/test_fixture/',
    created: { epochMs: 1_700_000_000_000, precisionMs: 1_000 }, source: 'live',
    observedAt: 1_800_000_000_000, body: 'Fixture content', media: ['Text'], ...overrides,
  };
}
function setup() {
  const store = new ReaderStore(':memory:');
  store.addSubreddit('python');
  const targetId = store.createTarget({ subreddit: 'python', upperMs: 1_900_000_000_000 });
  return { store, targetId, generation: store.generation };
}

test('discovered media preserves archive text and provenance, and live removal still hides it',()=>{
 const {store,targetId,generation}=setup();
 try{
  const archived=post({source:'archive',exportId:'archive-media',capturedAt:1700000100000,body:'Saved archive body',media:['Unknown']});
  store.importArchiveBatch(generation,[archived]);const before=store.getPost('abc')!;
  store.saveMediaReferences(generation,'abc',[{kind:'image',url:'https://i.redd.it/discovered.jpg'}]);
  const after=store.getPost('abc')!;
  for(const field of ['body','source','exportId','observedAt','capturedAt'] as const)assert.equal(after[field],before[field],field);
  assert.equal(after.attachments.length,1);assert.equal(store.queryFeed({media:'Image'}).posts.length,1);assert.equal(store.mediaSync('abc')?.status,'pending');
  store.commitBatch({generation,targetId,observations:[post({availability:'removed'})],continuation:null});
  assert.equal(store.getPost('abc')!.body,null);assert.deepEqual(store.getPost('abc')!.attachments,[]);assert.equal(store.mediaSync('abc'),null);
  store.importArchiveBatch(generation,[{...archived,observedAt:archived.observedAt+1000}]);
  store.saveMediaReferences(generation,'abc',[{kind:'image',url:'https://i.redd.it/discovered.jpg'}]);
  assert.equal(store.getPost('abc')!.body,null);assert.deepEqual(store.getPost('abc')!.attachments,[]);
 }finally{store.close();}
});

test('content, unique progress and continuation commit atomically, including replay', t => {
  const { store, targetId, generation } = setup();
  t.after(() => store.close());
  const batch = { generation, targetId, observations: [post(), post()], continuation: 'https://old.reddit.com/r/python/new/?after=t3_abc' };
  assert.deepEqual(store.commitBatch(batch), { newPosts: 1, newTargetPosts: 1 });
  assert.deepEqual(store.commitBatch(batch), { newPosts: 0, newTargetPosts: 0 });
  assert.equal(store.getTarget(targetId)!.observedCount, 1);
  assert.equal(store.getTarget(targetId)!.continuation, batch.continuation);
  assert.equal(store.listFeed().length, 1);
});

test('a partial live listing retains archived text and offline media without changing archive provenance',()=>{
 const {store,targetId,generation}=setup();try{
  const archive=post({source:'archive',exportId:'saved-caption',body:'A saved archive caption',media:['Image'],outbound:'https://i.redd.it/saved.jpg',attachments:[{kind:'image',url:'https://i.redd.it/saved.jpg'}]});
  store.importArchiveBatch(generation,[archive]);store.setMediaSync(generation,'abc','ready');const original=store.getPost('abc','archive');
  store.commitBatch({generation,targetId,continuation:null,observations:[post({title:'Current headline',body:undefined,media:['Unknown'],attachments:[],outbound:undefined,observedAt:1900000000000})]});
  const saved=store.getPost('abc')!;assert.equal(saved.title,'Current headline');assert.equal(saved.source,'live');assert.equal(saved.body,archive.body);
  assert.deepEqual(saved.attachments,archive.attachments);assert.equal(saved.outbound,archive.outbound);assert.equal(store.mediaSync('abc')?.status,'ready');
  assert.equal(store.queryFeed({text:'saved archive caption',media:'Image'}).posts.length,1);assert.deepEqual(store.getPost('abc','archive'),original);
  store.commitBatch({generation,targetId,continuation:null,observations:[post({availability:'removed',observedAt:1900000000001})]});
  store.importArchiveBatch(generation,[{...archive,observedAt:2000000000000}]);assert.equal(store.getPost('abc')?.body,null);assert.deepEqual(store.getPost('abc')?.attachments,[]);
 }finally{store.close();}
});

test('an explicit changed live media link invalidates old archive and discovered files',()=>{
 const {store,targetId,generation}=setup();try{
  store.importArchiveBatch(generation,[post({source:'archive',exportId:'old-image',media:['Image'],outbound:'https://i.redd.it/old.jpg',attachments:[{kind:'image',url:'https://i.redd.it/old.jpg'}]})]);
  store.saveMediaReferences(generation,'abc',[{kind:'image',url:'https://i.redd.it/old.jpg'}]);store.setMediaSync(generation,'abc','ready');
  store.commitBatch({generation,targetId,continuation:null,observations:[post({media:['Image'],outbound:'https://i.redd.it/new.jpg',attachments:[],observedAt:1900000000000})]});
  assert.equal(store.getPost('abc')?.outbound,'https://i.redd.it/new.jpg');assert.deepEqual(store.getPost('abc')?.attachments,[]);assert.equal(store.mediaSync('abc')?.status,'pending');
 }finally{store.close();}
});

test('a changed live media link discards attachments from the previous live observation',()=>{
 const {store,targetId,generation}=setup();try{
  store.commitBatch({generation,targetId,continuation:null,observations:[post({media:['Image'],outbound:'https://i.redd.it/old.jpg',attachments:[{kind:'image',url:'https://i.redd.it/old.jpg'}]})]});
  store.setMediaSync(generation,'abc','ready');
  store.commitBatch({generation,targetId,continuation:null,observations:[post({media:['Image'],outbound:'https://i.redd.it/new.jpg',attachments:[],observedAt:1900000000000})]});
  assert.deepEqual(store.getPost('abc')?.attachments,[]);assert.equal(store.mediaSync('abc')?.status,'pending');
 }finally{store.close();}
});

test('failure late in a batch rolls back posts, progress and checkpoint', t => {
  const { store, targetId, generation } = setup();
  t.after(() => store.close());
  store.commitBatch({ generation, targetId, observations: [post()], continuation: null });
  assert.throws(() => store.commitBatch({ generation, targetId, continuation: 'https://old.reddit.com/r/python/new/?after=t3_def', observations: [
    post({ id: 'def', permalink: '/r/python/comments/def/test/' }),
    post({ id: 'ghi', permalink: '/r/javascript/comments/ghi/test/' }),
  ] }), /identity/);
  assert.equal(store.getPost('def'), null);
  assert.equal(store.getTarget(targetId)!.observedCount, 1);
  assert.equal(store.getTarget(targetId)!.continuation, null);
});

test('new refresh intent preserves unfinished older history', t => {
  const { store, targetId, generation } = setup();
  t.after(() => store.close());
  store.commitBatch({ generation, targetId, observations: [post()], continuation: null, status: 'paused', reason: 'Budget exhausted' });
  const newer = store.createTarget({ subreddit: 'python', lowerMs: 1_800_000_000_000, upperMs: 1_900_000_000_000 });
  assert.deepEqual(store.listUnfinishedTargets().map(target => target.id), [targetId, newer]);
  assert.equal(store.getTarget(targetId)!.reason, 'Budget exhausted');
});

test('clearing all content resets the account binding; clearing one feed preserves it',()=>{
 const {store}=setup();try{
  store.bindAccount('original_user');store.clearSubreddit('python');assert.throws(()=>store.bindAccount('different_user'),/Account changed/);
  store.clearContent();store.bindAccount('different_user');assert.equal(store.getSetting('account'),'different_user');
 }finally{store.close();}
});

test('archive dedup keeps provenance separate and cannot advance a live target', t => {
  const { store, targetId, generation } = setup();
  t.after(() => store.close());
  const archive = post({ source: 'archive', exportId: 'export-1', body: 'Older archive body' });
  assert.equal(store.importArchiveBatch(generation, [archive]), 1);
  assert.equal(store.importArchiveBatch(generation, [archive]), 0);
  assert.equal(store.getPost('abc')!.source, 'archive');
  assert.equal(store.getTarget(targetId)!.observedCount, 0);
  assert.throws(() => store.commitBatch({ generation, targetId, observations: [archive], continuation: null }), /cannot advance/);
  store.commitBatch({ generation, targetId, observations: [post({ body: 'Current live body' })], continuation: null });
  store.importArchiveBatch(generation, [post({ source: 'archive', exportId: 'export-2', observedAt: 1_850_000_000_000, body: 'Other archive' })]);
  assert.equal(store.getPost('abc')!.body, 'Current live body');
  assert.equal(store.listFeed().length, 1);
});

test('partial and delayed live observations preserve newer fields; removal cannot be resurrected by archive', t => {
  const { store, targetId, generation } = setup();
  t.after(() => store.close());
  const commit = (observation: PostObservation) => store.commitBatch({ generation, targetId, observations: [observation], continuation: null });
  commit(post());
  commit(post({ observedAt: 1_800_000_001_000, body: undefined, media: undefined }));
  assert.equal(store.getPost('abc')!.body, 'Fixture content');
  assert.deepEqual(store.getPost('abc')!.media, ['Text']);
  commit(post({ observedAt: 1_700_000_001_000, body: 'Late old result' }));
  assert.equal(store.getPost('abc')!.body, 'Fixture content');
  commit(post({ observedAt: 1_800_000_002_000, body: '[removed]', media: undefined }));
  store.importArchiveBatch(generation, [post({ source: 'archive', exportId: 'old-export', observedAt: 1_900_000_000_000 })]);
  assert.equal(store.getPost('abc')!.availability, 'removed');
  assert.equal(store.getPost('abc')!.body, null);
  commit(post({ observedAt: 1_800_000_001_500 }));
  assert.equal(store.getPost('abc')!.availability, 'removed');
  commit(post({ observedAt: 1_800_000_002_500, body: undefined, media: undefined }));
  assert.equal(store.getPost('abc')!.availability, 'removed');
  commit(post({ observedAt: 1_800_000_003_000, body: 'Verified live reinstatement', availability: 'available' }));
  assert.equal(store.getPost('abc')!.body, 'Verified live reinstatement');
});

test('unknown sources produce a useful error and roll back mixed archive imports', t => {
  const { store, generation } = setup();
  t.after(() => store.close());
  assert.throws(() => store.createTarget({ subreddit: 'javascript', upperMs: 1_900_000_000_000 }), /Add r\/javascript/);
  assert.throws(() => store.importArchiveBatch(generation, [
    post({ source: 'archive', exportId: 'test-export' }),
    post({ id: 'def', subreddit: 'javascript', permalink: '/r/javascript/comments/def/test/', source: 'archive', exportId: 'test-export' }),
  ]), /Add r\/javascript/);
  assert.equal(store.listFeed().length, 0);
});

test('Clear rejects stale browser/import callbacks even after a new target is added', t => {
  const { store, targetId, generation } = setup();
  t.after(() => store.close());
  store.commitBatch({ generation, targetId, observations: [post()], continuation: null });
  assert.equal(store.clearContent(), generation + 1);
  const replacement = store.createTarget({ subreddit: 'python', upperMs: 1_900_000_000_000 });
  assert.throws(() => store.commitBatch({ generation, targetId: replacement, observations: [post()], continuation: null }), StaleGenerationError);
  assert.throws(() => store.importArchiveBatch(generation, [post({ source: 'archive', exportId: 'stale' })]), StaleGenerationError);
  assert.equal(store.listFeed().length, 0);
  assert.deepEqual(store.listSubreddits(), ['python']);
});

test('Clear removes content while retaining deletion protection for followed namespaces', t => {
  const { store, targetId, generation } = setup();
  t.after(() => store.close());
  store.commitBatch({ generation, targetId, observations: [post({ body: '[deleted]' })], continuation: null });
  const currentGeneration = store.clearContent();
  assert.deepEqual(store.listFeed(), []);
  assert.equal(store.getPost('abc'), null);
  store.importArchiveBatch(currentGeneration, [post({ source: 'archive', exportId: 'older-export', body: 'Old archived body' })]);
  assert.equal(store.getPost('abc')!.availability, 'deleted');
  assert.equal(store.getPost('abc')!.body, null);
  const target = store.createTarget({ subreddit: 'python', upperMs: 1_900_000_000_000 });
  store.commitBatch({ generation: currentGeneration, targetId: target, observations: [post({ observedAt: 1_790_000_000_000, availability: 'available' })], continuation: null });
  assert.equal(store.getPost('abc')!.availability, 'deleted');
  store.commitBatch({ generation: currentGeneration, targetId: target, observations: [post({ observedAt: 1_810_000_000_000, body: undefined, media: undefined })], continuation: null });
  assert.equal(store.getPost('abc')!.availability, 'deleted');
  store.commitBatch({ generation: currentGeneration, targetId: target, observations: [post({ observedAt: 1_820_000_000_000, body: 'Verified restored body', availability: 'available' })], continuation: null });
  assert.equal(store.getPost('abc')!.body, 'Verified restored body');
});

test('history checkpoint survives a real database restart without automatically resuming', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reddit-reader-test-'));
  const path = join(directory, 'reader.sqlite');
  let store = new ReaderStore(path);
  try {
    store.addSubreddit('python');
    const targetId = store.createTarget({ subreddit: 'python', upperMs: 1_900_000_000_000 });
    const next = 'https://old.reddit.com/r/python/new/?after=t3_abc';
    store.commitBatch({ generation: store.generation, targetId, observations: [post()], continuation: next });
    store.close();
    store = new ReaderStore(path);
    assert.equal(store.getTarget(targetId)!.continuation, next);
    assert.equal(store.getTarget(targetId)!.observedCount, 1);
    assert.equal(store.getTarget(targetId)!.status, 'paused');
    assert.match(store.getTarget(targetId)!.reason!, /Resume/);
    assert.equal(store.getPost('abc')!.body, 'Fixture content');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
