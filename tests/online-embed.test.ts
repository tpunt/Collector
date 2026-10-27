import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onlineEmbed} from '../src/online-embed.ts';
import {classifyMedia} from '../src/extract.ts';
import {ReaderStore} from '../src/store.ts';
import {mediaKey} from '../src/media-key.ts';

test('YouTube links use a fixed privacy-enhanced player and discard source playback/tracking parameters',()=>{
 for(const input of ['https://www.youtube.com/watch?v=M7lc1UVf-VE&autoplay=1&list=other','http://m.youtube.com/watch?v=M7lc1UVf-VE','https://youtu.be/M7lc1UVf-VE?si=tracking','https://youtube.com/shorts/M7lc1UVf-VE','https://youtube.com/live/M7lc1UVf-VE','https://www.youtube-nocookie.com/embed/M7lc1UVf-VE']){
  assert.deepEqual(onlineEmbed(input),{provider:'YouTube',url:'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=0&playsinline=1'});
 }
});

test('Vimeo links retain only the video ID and any supplied unlisted privacy hash',()=>{
 assert.deepEqual(onlineEmbed('https://vimeo.com/76979871?autoplay=1'),{provider:'Vimeo',url:'https://player.vimeo.com/video/76979871?autoplay=0'});
 for(const input of ['https://vimeo.com/76979871/abc123','https://player.vimeo.com/video/76979871?h=abc123&autoplay=1']){
  assert.deepEqual(onlineEmbed(input),{provider:'Vimeo',url:'https://player.vimeo.com/video/76979871?h=abc123&autoplay=0'});
  assert.deepEqual(classifyMedia({outbound:input,self:false,image:false,video:false}),['Video']);
 }
});

test('online embeds reject arbitrary hosts, supplied HTML, credentials, ports and invalid video paths',()=>{
 for(const input of [null,undefined,'','<iframe src="https://evil.test"></iframe>','javascript:alert(1)','//youtu.be/M7lc1UVf-VE','https://youtube.com.evil.test/watch?v=M7lc1UVf-VE','https://www.youtube.com@evil.test/watch?v=M7lc1UVf-VE','https://user@youtube.com/watch?v=M7lc1UVf-VE','https://youtube.com:444/watch?v=M7lc1UVf-VE','https://youtube.com/@channel','https://youtube.com/playlist?list=123','https://youtu.be/a/b','https://youtube.com/watch?v=a%2Fb','https://youtube.com/watch?v='+('a'.repeat(129)),'https://vimeo.com/76979871?h=','https://vimeo.com/76979871?h=a%26autoplay%3D1','https://vimeo.com/channels/staffpicks','https://evil.test/video/76979871'])assert.equal(onlineEmbed(input),null,input??'absent');
});

test('a provider preview image cannot count as the downloaded video',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('aww');store.importArchiveBatch(store.generation,[{id:'preview',subreddit:'aww',title:'External video preview',permalink:'/r/aww/comments/preview/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'preview-test',observedAt:1800000000000,media:['Video'],outbound:'https://www.youtube.com/watch?v=M7lc1UVf-VE',attachments:[{kind:'image',url:'https://preview.redd.it/poster.jpg'}]}]);
  assert.deepEqual(store.getPost('preview')?.attachments,[]);assert.equal(store.offlineMedia('aww').ready,0);assert.equal(store.offlineMedia('aww').pending,1);assert.equal(store.hasMediaOwner(mediaKey({kind:'image',url:'https://preview.redd.it/poster.jpg'})),false);
 }finally{store.close();}
});
