import type {DatabaseSync} from 'node:sqlite';
import {SEARCH_TEXT_SELECT} from './reader-fields.ts';

export const SCHEMA_VERSION=5;
const APPLICATION_ID=0x52524452;
const FAVOURITES_SCHEMA=`CREATE TABLE observation_authors (
  post_id TEXT NOT NULL, source_key TEXT NOT NULL, author TEXT NOT NULL CHECK(json_valid(author)),
  PRIMARY KEY(post_id,source_key),
  FOREIGN KEY(post_id,source_key) REFERENCES observations(post_id,source_key) ON DELETE CASCADE
);
CREATE INDEX observation_author_identity ON observation_authors(json_extract(author,'$.platform'),json_extract(author,'$.id'),post_id);
CREATE TABLE favourite_posts (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  saved_at INTEGER NOT NULL CHECK(saved_at>=0)
);
CREATE TABLE favourite_users (
  platform TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL,
  saved_at INTEGER NOT NULL CHECK(saved_at>=0), PRIMARY KEY(platform,user_id)
);`;
const SEARCH_SCHEMA=`CREATE TABLE search_text (
 post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,title TEXT NOT NULL,body TEXT NOT NULL
);
CREATE VIRTUAL TABLE search_index USING fts5(title,body,content='search_text',content_rowid='rowid',tokenize='trigram case_sensitive 1');
CREATE TRIGGER search_insert AFTER INSERT ON search_text BEGIN INSERT INTO search_index(rowid,title,body) VALUES(new.rowid,new.title,new.body); END;
CREATE TRIGGER search_delete AFTER DELETE ON search_text BEGIN INSERT INTO search_index(search_index,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body); END;
CREATE TRIGGER search_update AFTER UPDATE ON search_text BEGIN
 INSERT INTO search_index(search_index,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
 INSERT INTO search_index(rowid,title,body) VALUES(new.rowid,new.title,new.body); END;`;
export function rebuildSearch(db:DatabaseSync){db.exec(`DELETE FROM search_text; INSERT INTO search_text(post_id,title,body) ${SEARCH_TEXT_SELECT};`);}
const READ_SCHEMA=`CREATE TABLE read_states (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL CHECK(read_at>=0)
); CREATE INDEX read_states_time ON read_states(read_at,post_id);`;
const BODY_SCHEMA=`CREATE TABLE body_sync (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','fetching','ready','failed')),
  reason TEXT
); CREATE INDEX body_sync_status ON body_sync(status);`;

const SCHEMA=`
CREATE TABLE metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO metadata VALUES ('generation',0),('content_revision',0),('media_sync_revision',0);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)));
CREATE TABLE feeds (
  name TEXT PRIMARY KEY, subscribed INTEGER NOT NULL DEFAULT 1 CHECK(subscribed IN (0,1)),
  history_months INTEGER NOT NULL DEFAULT 1 CHECK(history_months IN (0,1,3,6,12,24,36,60)),
  history_target_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
  requested_ms INTEGER CHECK(requested_ms>=0)
);
CREATE TABLE posts (
  id TEXT PRIMARY KEY, subreddit TEXT NOT NULL REFERENCES feeds(name), permalink TEXT NOT NULL,
  created_ms INTEGER NOT NULL, precision_ms INTEGER NOT NULL,
  live_availability TEXT CHECK(live_availability IN ('available','removed','deleted')), live_state_at INTEGER
);
CREATE TABLE observations (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('live','archive')), export_id TEXT,
  title TEXT NOT NULL, body TEXT, media TEXT CHECK(media IS NULL OR json_valid(media)),
  availability TEXT NOT NULL CHECK(availability IN ('available','removed','deleted')),
  observed_at INTEGER NOT NULL, captured_at INTEGER,
  attachments TEXT CHECK(attachments IS NULL OR json_valid(attachments)), outbound TEXT,
  PRIMARY KEY(post_id,source_key)
);
CREATE INDEX feed_order ON posts(created_ms DESC,id DESC);
CREATE INDEX source_post_order ON posts(subreddit,created_ms DESC,id DESC);
CREATE INDEX archive_observations ON observations(export_id,post_id);
CREATE TABLE targets (
  id TEXT PRIMARY KEY, subreddit TEXT NOT NULL REFERENCES feeds(name), lower_ms INTEGER, upper_ms INTEGER NOT NULL,
  continuation TEXT, last_page TEXT, anchor_ms INTEGER NOT NULL,
  depends_on TEXT REFERENCES targets(id), started_at_head INTEGER NOT NULL DEFAULT 0 CHECK(started_at_head IN (0,1)),
  completion TEXT CHECK(completion IN ('date-boundary','listing-end','prior-scan')),
  observed_count INTEGER NOT NULL DEFAULT 0, omission_count INTEGER NOT NULL DEFAULT 0, oldest_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','paused','done','cancelled')), reason TEXT,
  boundary TEXT NOT NULL DEFAULT '{"olderIds":[],"batches":0,"lastSignature":null,"repeats":0}' CHECK(json_valid(boundary)),
  CHECK(lower_ms IS NULL OR (lower_ms>=0 AND lower_ms<=upper_ms)),
  CHECK((status='done')=(completion IS NOT NULL))
);
CREATE TABLE target_posts (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, PRIMARY KEY(target_id,post_id)
);
CREATE INDEX target_post_lookup ON target_posts(post_id);
CREATE TABLE target_batches (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE, signature TEXT NOT NULL, PRIMARY KEY(target_id,signature)
);
CREATE TABLE feed_sync (
  subreddit TEXT PRIMARY KEY REFERENCES feeds(name), run_id TEXT NOT NULL, targets TEXT NOT NULL CHECK(json_valid(targets)),
  state TEXT NOT NULL CHECK(state IN ('running','incomplete','complete','gaps')), started_ms INTEGER NOT NULL,
  last_success_ms INTEGER, last_completed_ms INTEGER, reason TEXT, gap_count INTEGER NOT NULL DEFAULT 0,
  CHECK(state<>'complete' OR (last_success_ms IS NOT NULL AND last_completed_ms IS NOT NULL)),
  CHECK(state<>'gaps' OR last_completed_ms IS NOT NULL)
);
CREATE TABLE thread_snapshots (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('live','archive')), data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX snapshot_post ON thread_snapshots(post_id,observed_at DESC);
-- Removal evidence is independent of stored post content and survives global Clear.
CREATE TABLE comment_states (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('available','removed','deleted')), observed_at INTEGER NOT NULL
);
CREATE INDEX comment_state_post ON comment_states(post_id);
CREATE TABLE archive_fetches (
  id TEXT PRIMARY KEY, subreddit TEXT NOT NULL REFERENCES feeds(name), updated_ms INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE media_sync (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','downloading','ready','failed','unavailable')),
  reason TEXT, signature TEXT NOT NULL, session TEXT
);
CREATE INDEX media_sync_status ON media_sync(status,session);
CREATE TABLE media_evidence (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE, attachments TEXT NOT NULL CHECK(json_valid(attachments)), observed_at INTEGER NOT NULL
);
CREATE TABLE post_media (
  key TEXT NOT NULL, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, PRIMARY KEY(key,post_id)
);
CREATE INDEX media_owner_post ON post_media(post_id);
CREATE TABLE excluded_posts (post_id TEXT PRIMARY KEY, subreddit TEXT NOT NULL, deleted_at INTEGER NOT NULL);
${BODY_SCHEMA}
${READ_SCHEMA}
${SEARCH_SCHEMA}
${FAVOURITES_SCHEMA}
`;

/** Unknown/prototype schemas are rejected. Published versions receive additive,
 * transactional upgrades that preserve content and preferences. */
export function initializeSchema(db:DatabaseSync):void {
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  const application=Number(db.prepare('PRAGMA application_id').get()!.application_id);
  const empty=!db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if(!(version===0&&application===0&&empty)&&!([1,2,3,4,SCHEMA_VERSION].includes(version)&&application===APPLICATION_ID))
    throw new Error(`Unsupported reader database schema (${version}). Back up and move aside reader.sqlite and its WAL/SHM files, then restart to create a fresh database.`);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  if(empty){
    db.exec('BEGIN IMMEDIATE');
    try{db.exec(SCHEMA);db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);}
    catch(error){db.exec('ROLLBACK');throw error;}
  }else if(version===1){
    // One additive upgrade preserves existing libraries; prototype schemas are
    // still rejected. The next explicit sync verifies previously unsaved text.
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec(BODY_SCHEMA);
      db.exec(`INSERT INTO body_sync(post_id,status)
        SELECT p.id,CASE WHEN o.source='archive' AND o.body IS NOT NULL THEN 'ready' ELSE 'pending' END
        FROM posts p JOIN observations o ON o.post_id=p.id
        WHERE coalesce(p.live_availability,o.availability)='available' AND EXISTS(SELECT 1 FROM json_each(o.media) WHERE value='Text')
        AND o.rowid=(SELECT rowid FROM observations WHERE post_id=p.id ORDER BY (source='live') DESC,observed_at DESC,source_key DESC LIMIT 1);
        UPDATE feed_sync SET state='incomplete',last_success_ms=NULL,reason='Post text needs verification; Sync to finish saving this feed'
          WHERE EXISTS(SELECT 1 FROM body_sync b JOIN posts p ON p.id=b.post_id WHERE p.subreddit=feed_sync.subreddit AND b.status<>'ready');
        PRAGMA user_version=2; COMMIT;`);
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!empty&&version<3){
    db.exec('BEGIN IMMEDIATE');
    try{db.exec(READ_SCHEMA);db.exec('PRAGMA user_version=3; COMMIT;');}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!empty&&version<4){
    db.exec('BEGIN IMMEDIATE');
    try{db.exec(SEARCH_SCHEMA);rebuildSearch(db);db.exec('PRAGMA user_version=4; COMMIT;');}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!empty&&version<5){
    db.exec('BEGIN IMMEDIATE');
    try{db.exec(FAVOURITES_SCHEMA);db.exec('PRAGMA user_version=5; COMMIT;');}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
}

/** Crash/shutdown recovery for current-schema work. Startup never starts network requests. */
export function recoverInterruptedWork(db:DatabaseSync):void {
  db.exec(`BEGIN IMMEDIATE;
    UPDATE targets SET status='paused',reason='Application restarted; Resume to continue' WHERE status='queued';
    UPDATE media_sync SET status='pending',reason='Sync interrupted; Resume to finish saving this feed' WHERE status='downloading';
    UPDATE body_sync SET status='pending',reason='Sync interrupted; Resume to finish saving post text' WHERE status='fetching';
    UPDATE feed_sync SET state='incomplete',reason='Application restarted; Resume to finish saving this feed' WHERE state='running';
    UPDATE archive_fetches SET data=json_set(data,'$.state','paused','$.reason','Application restarted; Resume to continue') WHERE json_extract(data,'$.state')='running';
    COMMIT;`);
}
