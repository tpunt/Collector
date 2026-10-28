import assert from 'node:assert/strict';
import {createReaderServer} from '../src/server.ts';

/** Collection/player tests explicitly permit their local fake network. Startup
 * permission tests use the real factory directly; production has no bypass. */
export async function createOnlineReaderServer(options:Parameters<typeof createReaderServer>[0]){
  const app=createReaderServer(options);
  try{assert.equal(app.networkMode.status.offline,true);await app.networkMode.change(false);return app;}
  catch(error){await app.close();throw error;}
}
