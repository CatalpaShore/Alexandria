import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";

const root = await fs.mkdtemp(path.join(os.tmpdir(),"alexandria-import-"));
process.env.DATA_DIR=path.join(root,"state");
process.env.MEDIA_SOURCES=`LOCAL:Library=${path.join(root,"media")}`;
process.env.AMW_AGENT_ENABLED="false";
const {db}=await import("../../server/src/db.js");
const {scanMediaLibrary}=await import("../../server/src/scanner.js");
const {readFavoriteKeys,writeFavoriteKeys}=await import("../../server/src/favorites.js");
const {parseLocalNfo,parseLocalJson,isLibraryArtwork}=await import("../../server/src/localLibraryImport.js");
const mediaRoot=path.join(root,"media");
beforeAll(()=>fs.mkdir(mediaRoot,{recursive:true}));
beforeEach(async()=>{
 db.exec("DELETE FROM media_files; DELETE FROM media_metadata; DELETE FROM playback_progress; DELETE FROM media_metadata_facets;");
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='library_path_aliases'").get())db.exec("DELETE FROM library_path_aliases;");
 await fs.rm(mediaRoot,{recursive:true,force:true});await fs.mkdir(mediaRoot,{recursive:true});
 await fs.rm(path.join(root,"state","library-sources.json"),{force:true});
 process.env.MEDIA_SOURCES=`LOCAL:Library=${mediaRoot}`;writeFavoriteKeys(new Set());
});
afterAll(async()=>{db.close();await fs.rm(root,{recursive:true,force:true})});

describe("public local-library compatibility",()=>{
 it("makes a new library's metadata and subtitles available before full-file hashing",async()=>{
  await fs.writeFile(path.join(mediaRoot,"Example.mp4"),"neutral-video-fixture");
  await fs.writeFile(path.join(mediaRoot,"Example.nfo"),"<movie><title>Example title</title></movie>");
  await fs.writeFile(path.join(mediaRoot,"Example.en.srt"),"1\n00:00:00,000 --> 00:00:01,000\nHello\n");
  const phases:string[]=[]; let visibleBeforeHash=false;
  await scanMediaLibrary({forceFull:true,onProgress:progress=>phases.push(progress.phase),onInitialReady:()=>{
   visibleBeforeHash=Boolean(db.prepare("SELECT 1 FROM media_metadata WHERE title='Example title'").get()) &&
     Boolean(db.prepare("SELECT 1 FROM media_sidecars WHERE language='en'").get()) &&
     (db.prepare("SELECT COUNT(*) n FROM library_file_identity").get() as {n:number}).n===0;
  }});
  expect(visibleBeforeHash).toBe(true);
  expect(phases).toContain("fingerprinting");
  expect(db.prepare("SELECT COUNT(*) n FROM library_file_identity").get()).toEqual({n:1});
 });
 it("associates language subtitles with the right directory and common Subs folders",async()=>{
  const one=path.join(mediaRoot,"one"),two=path.join(mediaRoot,"two");
  await fs.mkdir(path.join(one,"Subs"),{recursive:true});await fs.mkdir(two,{recursive:true});
  await fs.writeFile(path.join(one,"AAA-101 first.mp4"),"first-video");
  await fs.writeFile(path.join(two,"AAA-101 second.mp4"),"second-video");
  await fs.writeFile(path.join(one,"Subs","AAA-101 first.zh-Hant.srt"),"subtitle");
  await fs.writeFile(path.join(two,"AAA-101 second.zh-CN.srt"),"subtitle");
  await scanMediaLibrary({forceFull:true});
  expect(db.prepare(`SELECT m.name, s.language FROM media_sidecars s JOIN media_files m ON m.id=s.media_id WHERE s.kind='subtitle' ORDER BY m.name`).all()).toEqual([
   {name:"AAA-101 first.mp4",language:"zh-TW"},{name:"AAA-101 second.mp4",language:"zh-CN"}
  ]);
 });
 it("keeps distinct source identities when categories share a name and root",async()=>{
  await fs.writeFile(path.join(mediaRoot,"Example.mp4"),"fixture");
  process.env.MEDIA_SOURCES=`FIRST:Library=${mediaRoot};SECOND:Library=${mediaRoot}`;
  await scanMediaLibrary({forceFull:true});
  const rows=db.prepare("SELECT id,library_category FROM media_files ORDER BY library_category").all() as Array<{id:string;library_category:string}>;
  expect(rows.map(row=>row.library_category)).toEqual(["FIRST","SECOND"]);
  expect(new Set(rows.map(row=>row.id)).size).toBe(2);
  const original=rows.map(row=>row.id);
  await scanMediaLibrary({forceFull:true});
  expect((db.prepare("SELECT id FROM media_files ORDER BY library_category").all() as Array<{id:string}>).map(row=>row.id)).toEqual(original);
 });
 it("imports NFO then per-field JSON, leaves artwork out of the wall and source bytes unchanged",async()=>{
  const video=path.join(mediaRoot,"Holiday.mp4"),nfo=path.join(mediaRoot,"Holiday.nfo");
  await fs.writeFile(video,"neutral-video-fixture");await fs.writeFile(nfo,'<movie><title>NFO title</title><plot>Local plot</plot><actor><name>Demo Person</name></actor><genre>Travel</genre><set><name>Holidays</name></set><year>2024</year></movie>');
  await fs.writeFile(path.join(mediaRoot,"Holiday.media.json"),JSON.stringify({title:"JSON title",tags:["Coast"]}));await fs.writeFile(path.join(mediaRoot,"Holiday-poster.JPG"),"authored-art-placeholder");
  const before=await fs.readFile(nfo);await scanMediaLibrary({forceFull:true});
  expect(db.prepare("SELECT COUNT(*) n FROM media_files").get()).toEqual({n:1});
  expect(db.prepare("SELECT title,summary,actors_json,genres_json,series,release_date FROM media_metadata").get()).toEqual({title:"JSON title",summary:"Local plot",actors_json:'["Demo Person"]',genres_json:'["Coast"]',series:"Holidays",release_date:"2024-01-01"});
  expect((db.prepare("SELECT artwork_path FROM library_local_import").get() as {artwork_path:string}).artwork_path).toBe(await fs.realpath(path.join(mediaRoot,"Holiday-poster.JPG")));
  expect(await fs.readFile(nfo)).toEqual(before);expect(await fs.readFile(video,"utf8")).toBe("neutral-video-fixture");
  db.prepare("UPDATE media_metadata SET title='User title'").run();await fs.writeFile(path.join(mediaRoot,"Holiday.media.json"),JSON.stringify({title:"Updated sidecar"}));await scanMediaLibrary({forceFull:true});
  expect(db.prepare("SELECT title FROM media_metadata").get()).toEqual({title:"User title"});
 });
 it("retains legacy IDs, favorites, progress and playlists across rename and root relocation",async()=>{
  const source=path.join(mediaRoot,"Original.mp4");await fs.writeFile(source,"unique-full-content");await scanMediaLibrary({forceFull:true});
  const old=db.prepare("SELECT id,relative_path FROM media_files").get() as {id:string;relative_path:string};
  writeFavoriteKeys(new Set([old.relative_path]));
  db.prepare("INSERT INTO playback_progress(relative_path,media_id,position_seconds,duration_seconds,completed,play_count,last_played_at,updated_at) VALUES(?,?,42,100,0,2,'2026-01-01','2026-01-01')").run(old.relative_path,old.id);
  db.prepare("INSERT INTO playlists(id,name,created_at,updated_at) VALUES('test-list','Watch later','now','now')").run();
  db.prepare("INSERT INTO playlist_items(playlist_id,media_id,position,added_at) VALUES('test-list',?,0,'now')").run(old.id);
  await fs.rename(source,path.join(mediaRoot,"Renamed.mp4"));await scanMediaLibrary({forceFull:true});
  const renamed=db.prepare("SELECT id,relative_path FROM media_files").get() as {id:string;relative_path:string};
  expect(renamed.id).toBe(old.id);expect(readFavoriteKeys().has(renamed.relative_path)).toBe(true);
  expect(db.prepare("SELECT media_id,position_seconds,relative_path FROM playback_progress").get()).toEqual({media_id:old.id,position_seconds:42,relative_path:renamed.relative_path});
  expect(db.prepare("SELECT media_id FROM playlist_items WHERE playlist_id='test-list'").get()).toEqual({media_id:old.id});
  const moved=path.join(root,"relocated");await fs.rename(mediaRoot,moved);process.env.MEDIA_SOURCES=`LOCAL:Library=${moved}`;await scanMediaLibrary({forceFull:true});
  expect(db.prepare("SELECT id,absolute_path FROM media_files").get()).toEqual({id:old.id,absolute_path:path.join(moved,"Renamed.mp4")});
  await fs.rename(moved,mediaRoot);
 });
 it("preserves records on an empty source and refuses ambiguous duplicate relinks",async()=>{
  await fs.writeFile(path.join(mediaRoot,"Old.mp4"),"same-content");await scanMediaLibrary({forceFull:true});const old=db.prepare("SELECT id FROM media_files").get() as {id:string};
  await fs.unlink(path.join(mediaRoot,"Old.mp4"));expect((await scanMediaLibrary({forceFull:true})).removed).toBe(0);expect(db.prepare("SELECT id FROM media_files").get()).toEqual(old);
  await fs.writeFile(path.join(mediaRoot,"Copy A.mp4"),"same-content");await fs.writeFile(path.join(mediaRoot,"Copy B.mp4"),"same-content");await scanMediaLibrary({forceFull:true});
  expect(db.prepare("SELECT COUNT(*) n FROM media_files").get()).toEqual({n:3});expect(db.prepare("SELECT available FROM library_availability WHERE media_id=?").get(old.id)).toEqual({available:0});
 });
 it("rejects active XML declarations and invalid JSON without interpreting remote content",()=>{
  expect(()=>parseLocalNfo('<!DOCTYPE movie [<!ENTITY x SYSTEM "file:///etc/passwd">]><movie><title>&x;</title></movie>')).toThrow();
  expect(()=>parseLocalJson({title:7})).toThrow();expect(isLibraryArtwork("poster.jpg",[])).toBe(false);
 });
});
