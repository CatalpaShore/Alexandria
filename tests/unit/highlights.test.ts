import {beforeAll, beforeEach, afterAll, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import express from 'express';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';

type FixtureMedia = {id:string; absolute_path:string; media_type:string; duration_seconds:number; normalized_code:string|null; basename:string; extension:string};
type FixtureHandler = (job:{media_id:string}, media:FixtureMedia|undefined)=>Promise<void>;
type ClipResponse = {id:string; status:string};

const state=vi.hoisted(()=>({user:'user-a',root:'',handler:null as unknown as FixtureHandler,refill:null as unknown as ()=>void,db:null as unknown as Database.Database}));
vi.mock('../../server/src/db.js',()=>({db:state.db}));
vi.mock('../../server/src/config.js',()=>({config:{externalAi:{root:state.root,markerFile:'marker.json',expectedStorageId:'test'},mediaWorkerFfmpegThreads:1},getMediaSources:()=>[{root:state.root}]}));
vi.mock('../../server/src/userProfiles.js',()=>({getActiveUserProfile:()=>({id:state.user})}));
vi.mock('../../server/src/mediaJobs.js',()=>({enqueueMediaJob:vi.fn(),registerMediaJobHandler:(_type:string,handler:FixtureHandler)=>{state.handler=handler;},registerMediaJobIdleRefillHandler:(_name:string,handler:()=>void)=>{state.refill=handler;}}));
let server:Server,base:string,mod:typeof import('../../server/src/highlights.js'),source:string,original:Buffer;
const post=(body:unknown)=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const input={mediaId:'video',title:'Neutral test clip',start:1,end:3};
const processClip=()=>state.handler({media_id:'video'},state.db.prepare('SELECT * FROM media_files').get() as FixtureMedia);
beforeAll(async()=>{
 state.root=fs.mkdtempSync(path.join(os.tmpdir(),'amw-highlights-'));
 fs.writeFileSync(path.join(state.root,'marker.json'),JSON.stringify({product:'alexandria-ai',storageId:'test'}));
 source=path.join(state.root,'neutral.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-f','lavfi','-i','sine=frequency=440','-t','5','-c:v','libx264','-c:a','aac',source]);
 original=fs.readFileSync(source);
 state.db=new Database(':memory:');
 state.db.exec('CREATE TABLE media_files(id TEXT PRIMARY KEY,absolute_path TEXT,media_type TEXT,duration_seconds REAL,normalized_code TEXT,basename TEXT,extension TEXT)');
 state.db.exec('CREATE TABLE media_jobs(media_id TEXT,job_type TEXT,status TEXT,lease_expires_at TEXT)');
 state.db.prepare('INSERT INTO media_files VALUES(?,?,?,?,?,?,?)').run('video',source,'video',5,null,'neutral','.mp4');
 mod=await import('../../server/src/highlights.js');
 const app=express();app.use(express.json());mod.registerHighlightRoutes(app);
 app.use((err:Error & {status?:number},_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(err.status||(err.name==='ZodError'?400:500)).json({error:err.message}));
 server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/highlights`;
});
beforeEach(()=>{
 state.user='user-a';state.db.exec('DELETE FROM media_highlights; DELETE FROM media_jobs;');
 fs.writeFileSync(source,original);
});
afterAll(async()=>{mod.stopHighlightRecovery();await new Promise<void>(resolve=>server.close(()=>resolve()));state.db.close();fs.rmSync(state.root,{recursive:true,force:true});});
describe('highlight exports',()=>{
 it('does not crash encoding when a concurrent scan locks progress writes',()=>{
  const prepare=vi.spyOn(state.db,'prepare').mockImplementationOnce(()=>({run:()=>{throw Object.assign(new Error('locked'),{code:'SQLITE_BUSY'});}} as unknown as Database.Statement));
  try {expect(()=>mod.recordHighlightProgress('test',10)).not.toThrow();}finally{prepare.mockRestore();}
 });
 it('rejects invalid ranges and source overrun',async()=>{
  for(const range of [{start:3,end:2},{start:-1,end:2},{start:1,end:1.2},{start:0,end:1801},{start:4,end:7}])expect((await post({...input,...range})).status).toBe(400);
 });
 it('exports queued clips, isolates users, streams ranges and deletes only the clip',async()=>{
  const first=await post(input);expect(first.status).toBe(202);const {id}=await first.json();
  const second=await post({...input,start:0,end:1});expect(second.status).toBe(202);
  expect((await fetch(`${base}/${id}/file`)).status).toBe(409);
  await processClip();
  const list=await (await fetch(base)).json();expect(list.items).toHaveLength(2);expect(list.items.every((c:ClipResponse)=>c.status==='ready')).toBe(true);
  const output=path.join(state.root,'highlights',`${id}.mp4`);
  const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output],{encoding:'utf8'}));expect(Math.abs(duration-2)).toBeLessThan(0.3);
  expect(list.items.find((clip:ClipResponse)=>clip.id===id)).toMatchObject({progress:100,attempts:1,posterUrl:`/api/highlights/${id}/poster`});
  expect((await fetch(`${base}/${id}/poster`)).headers.get('content-type')).toContain('image/jpeg');
  const range=await fetch(`${base}/${id}/file`,{headers:{Range:'bytes=0-99'}});expect(range.status).toBe(206);expect((await range.arrayBuffer()).byteLength).toBe(100);
  state.user='user-b';expect((await (await fetch(base)).json()).items).toHaveLength(0);expect((await fetch(`${base}/${id}/file`)).status).toBe(404);expect((await fetch(`${base}/${id}`,{method:'DELETE'})).status).toBe(404);
  state.user='user-a';expect((await fetch(`${base}/${id}`,{method:'DELETE'})).status).toBe(204);expect(fs.existsSync(output)).toBe(false);expect(fs.readFileSync(source)).toEqual(original);
 });
 it('rejects missing storage without creating a fallback and supports retry',async()=>{
  fs.renameSync(path.join(state.root,'marker.json'),path.join(state.root,'marker.off'));
  expect((await post(input)).status).toBe(503);expect((await (await fetch(base)).json()).storageAvailable).toBe(false);
  fs.renameSync(path.join(state.root,'marker.off'),path.join(state.root,'marker.json'));
  const {id}=await (await post(input)).json();
  state.db.prepare('UPDATE media_highlights SET source_size=0 WHERE id=?').run(id);
  await processClip();
  expect(state.db.prepare('SELECT status FROM media_highlights WHERE id=?').get(id)).toEqual({status:'failed'});
  expect((await fetch(`${base}/${id}/retry`,{method:'POST'})).status).toBe(202);
  state.db.prepare('UPDATE media_highlights SET source_size=? WHERE id=?').run(original.length,id);
  await processClip();
  expect(state.db.prepare('SELECT status FROM media_highlights WHERE id=?').get(id)).toEqual({status:'ready'});
 });
 it('marks missing-source jobs failed instead of leaving them pending',async()=>{
  const {id}=await (await post(input)).json();state.db.prepare('UPDATE media_highlights SET media_id=? WHERE id=?').run('missing',id);state.refill();
  expect(state.db.prepare('SELECT status FROM media_highlights WHERE id=?').get(id)).toEqual({status:'failed'});
 });
 it('waits for disconnected storage without consuming retries, then resumes',async()=>{
  const {id}=await (await post(input)).json();
  fs.renameSync(path.join(state.root,'marker.json'),path.join(state.root,'marker.off'));
  try {
   await processClip();
   expect(state.db.prepare('SELECT status,attempts,error_code FROM media_highlights WHERE id=?').get(id)).toEqual({status:'waiting',attempts:0,error_code:'STORAGE_UNAVAILABLE'});
  } finally {fs.renameSync(path.join(state.root,'marker.off'),path.join(state.root,'marker.json'));}
  state.db.prepare('UPDATE media_highlights SET retry_after=NULL WHERE id=?').run(id);
  state.refill();await processClip();
  expect(state.db.prepare('SELECT status,attempts FROM media_highlights WHERE id=?').get(id)).toEqual({status:'ready',attempts:1});
 });
 it('bounds automatic retries for corrupt inputs and permits explicit repair',async()=>{
  fs.writeFileSync(source,'invalid mp4');
  const {id}=await (await post(input)).json();
  for(let attempt=1;attempt<=3;attempt++) {
   await processClip();
   expect(state.db.prepare('SELECT status,attempts FROM media_highlights WHERE id=?').get(id)).toEqual({status:attempt<3?'retrying':'failed',attempts:attempt});
   state.db.prepare('UPDATE media_highlights SET retry_after=NULL WHERE id=?').run(id);
  }
  state.refill();await processClip();
  expect(state.db.prepare('SELECT attempts FROM media_highlights WHERE id=?').get(id)).toEqual({attempts:3});
  const result=await fetch(`${base}/repair`,{method:'POST'});expect((await result.json()).repaired).toBe(1);
  expect(state.db.prepare('SELECT status,attempts FROM media_highlights WHERE id=?').get(id)).toEqual({status:'pending',attempts:0});
 });
 it('recovers interrupted jobs while protecting active leases and retry budgets',async()=>{
  const {id}=await (await post(input)).json();
  state.db.prepare("UPDATE media_highlights SET status='processing',attempts=1 WHERE id=?").run(id);
  state.db.prepare('INSERT INTO media_jobs VALUES(?,?,?,?)').run('video','highlight','running',new Date(Date.now()+60_000).toISOString());
  state.refill();expect(state.db.prepare('SELECT status FROM media_highlights WHERE id=?').get(id)).toEqual({status:'processing'});
  state.db.exec('DELETE FROM media_jobs');state.refill();
  expect(state.db.prepare('SELECT status FROM media_highlights WHERE id=?').get(id)).toEqual({status:'pending'});
  await processClip();
  expect(state.db.prepare('SELECT status,attempts FROM media_highlights WHERE id=?').get(id)).toEqual({status:'ready',attempts:2});
  state.db.prepare("UPDATE media_highlights SET status='processing',attempts=3 WHERE id=?").run(id);state.refill();
  expect(state.db.prepare('SELECT status FROM media_highlights WHERE id=?').get(id)).toEqual({status:'failed'});
 });
 it('repairs a missing exported file and refuses deleting queued work',async()=>{
  const {id}=await (await post(input)).json();
  expect((await fetch(`${base}/${id}`,{method:'DELETE'})).status).toBe(409);
  await processClip();
  fs.unlinkSync(path.join(state.root,'highlights',`${id}.mp4`));
  expect((await fetch(`${base}/${id}/file`)).status).toBe(409);
  expect(state.db.prepare('SELECT status,attempts,progress FROM media_highlights WHERE id=?').get(id)).toEqual({status:'pending',attempts:0,progress:0});
  await processClip();
  expect((await fetch(`${base}/${id}/file`)).status).toBe(200);
 });
});
