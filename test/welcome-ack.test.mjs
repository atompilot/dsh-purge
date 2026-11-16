import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readWelcomeAckFile,welcomeAckPath} from '../lib/welcome-ack.js';
test('welcome ack is per DSH home and malformed content stays unacked',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'purge-welcome-ack-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 assert.equal(readWelcomeAckFile(home).acked,false);
 const file=welcomeAckPath(home);fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({acked:true,at:'2026-11-16T00:00:00.000Z',source:'installer'}));
 const state=readWelcomeAckFile(home);assert.equal(state.acked,true);assert.equal(state.source,'installer');
 fs.writeFileSync(file,'{bad');assert.equal(readWelcomeAckFile(home).acked,false);
});
