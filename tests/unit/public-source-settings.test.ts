import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type {Server} from "node:http";
import {beforeAll,afterAll,describe,expect,it,vi} from "vitest";
import {config} from "../../server/src/config.js";
import {registerLibrarySourceRoutes} from "../../server/src/librarySourceRoutes.js";
let server:Server,base:string;const startScan=vi.fn(async()=>({}));
beforeAll(async()=>{const app=express();app.use(express.json());registerLibrarySourceRoutes(app,startScan,()=>false);server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterAll(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
const request=(url:string,method:string,body:unknown)=>fetch(base+url,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
describe("source migration preview",()=>{
 it("reports a bounded sample without reading or modifying the original files",async()=>{
  const root=path.join(config.dataDir,"sample-source");await fs.mkdir(path.join(root,"Movies"),{recursive:true});
  await fs.writeFile(path.join(root,"Movies","Example.m2ts"),"neutral video");
  await fs.writeFile(path.join(root,"Movies","Example.en.srt"),"neutral subtitle");
  await fs.writeFile(path.join(root,"Movies","Example.nfo"),"<movie/>");
  const sources=[{category:"LOCAL",name:"Sample",root}];
  const response=await request("/api/settings/library-sources/preview","POST",{sources});
  const preview=await response.json();
  expect(preview.targets[0].sample).toMatchObject({videos:1,subtitles:1,metadata:1,limited:false});
  expect(await fs.readFile(path.join(root,"Movies","Example.m2ts"),"utf8")).toBe("neutral video");
 });
 it("requires a current preview and explicit empty-directory acknowledgement before backing up and saving",async()=>{
  const root=path.join(config.dataDir,"source");await fs.mkdir(root,{recursive:true});const sources=[{category:"LOCAL",name:"Library",root}];
  expect((await request("/api/settings/library-sources","PUT",{sources})).status).toBe(409);expect(startScan).not.toHaveBeenCalled();
  const preview=await (await request("/api/settings/library-sources/preview","POST",{sources})).json();expect(preview.targets[0]).toMatchObject({empty:true,readable:true});
  expect((await request("/api/settings/library-sources","PUT",{sources,previewId:preview.previewId})).status).toBe(409);
  expect((await request("/api/settings/library-sources","PUT",{sources,previewId:preview.previewId,allowEmpty:true})).status).toBe(200);expect(startScan).toHaveBeenCalledOnce();expect((await fs.readdir(path.join(config.dataDir,"upgrade-backups"))).length).toBe(1);
  expect((await request("/api/settings/library-sources","PUT",{sources,previewId:preview.previewId,allowEmpty:true})).status).toBe(409);
 });
});
