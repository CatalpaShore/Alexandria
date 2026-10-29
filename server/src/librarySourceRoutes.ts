import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";
import { z } from "zod";
import { config, getMediaSources } from "./config.js";
import { db } from "./db.js";
import { sampleLibrarySource } from "./librarySourceSample.js";

const label = z.string().trim().min(1).max(80).regex(/^[^/\\:\r\n\0]+$/);
const sourcesSchema = z.array(z.object({category:label,name:label,root:z.string().trim().refine(path.isAbsolute,"Use an absolute mounted directory")})).min(1).max(32).superRefine((sources,context) => {
  const names = sources.map(s=>`${s.category}/${s.name}`);
  if (new Set(names).size !== names.length) context.addIssue({code:"custom",message:"Source category/name pairs must be unique"});
});
const fingerprint = (value:unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function registerLibrarySourceRoutes(app:Express, startScan:()=>Promise<unknown>, isScanActive:()=>boolean):void {
  const previews = new Map<string,{fingerprint:string;expires:number}>();
  const inspect = async (sources:z.infer<typeof sourcesSchema>) => Promise.all(sources.map(async source => {
    try {
      const stat = await fs.stat(source.root);
      if (!stat.isDirectory()) throw new Error("Not a directory");
      const names = await fs.readdir(source.root);
      return {...source,readable:true,empty:names.length===0,directEntries:names.length,mtimeMs:stat.mtimeMs};
    } catch { return {...source,readable:false,empty:false,directEntries:0,mtimeMs:0}; }
  }));
  app.get("/api/settings/library-sources",(_req,res)=>res.json({sources:getMediaSources()}));
  app.post("/api/settings/library-sources/preview",async(req,res,next)=>{
    try {
      const sources=sourcesSchema.parse(req.body.sources).map(s=>({...s,root:path.resolve(s.root)}));
      const targets=await inspect(sources), current=getMediaSources();
      const previewId=crypto.randomUUID();
      for(const [id,item] of previews) if(item.expires<Date.now())previews.delete(id);
      if(previews.size>=64)previews.delete(previews.keys().next().value!);
      previews.set(previewId,{fingerprint:fingerprint({targets,current}),expires:Date.now()+600000});
      const retained=(db.prepare("SELECT COUNT(*) AS count FROM media_files").get() as {count:number}).count;
      const sampledTargets = await Promise.all(targets.map(async target => ({ ...target, sample: target.readable ? await sampleLibrarySource(target.root) : null })));
      res.json({previewId,sources,targets:sampledTargets,retainedRecords:retained,policy:"Keep existing media IDs and user records; read sources without moving or renaming files."});
    } catch(error){next(error)}
  });
  app.put("/api/settings/library-sources",async(req,res,next)=>{
    try {
      if(isScanActive())return void res.status(409).json({error:"Wait for the active scan before changing sources"});
      const sources=sourcesSchema.parse(req.body.sources).map(s=>({...s,root:path.resolve(s.root)}));
      const preview=previews.get(String(req.body.previewId));
      const targets=await inspect(sources);
      if(!preview||preview.expires<Date.now()||preview.fingerprint!==fingerprint({targets,current:getMediaSources()}))return void res.status(409).json({error:"Source preview expired or changed; preview again"});
      if(targets.some(t=>!t.readable))return void res.status(400).json({error:"Every source must be a readable mounted directory"});
      if(targets.some(t=>t.empty)&&req.body.allowEmpty!==true)return void res.status(409).json({error:"Confirm the empty source explicitly"});
      const backups=path.join(config.dataDir,"upgrade-backups");await fs.mkdir(backups,{recursive:true,mode:0o700});
      const backup=path.join(backups,`before-sources-${Date.now()}.sqlite`);await db.backup(backup);await fs.chmod(backup,0o600);
      const target=path.join(config.dataDir,"library-sources.json");
      await fs.writeFile(`${target}.tmp`,JSON.stringify({sources,updatedAt:new Date().toISOString()},null,2),{mode:0o600});await fs.rename(`${target}.tmp`,target);
      previews.delete(String(req.body.previewId));
      void startScan().catch(error=>console.error("Library source scan failed",error));
      res.json({sources,scanning:true,backupCreated:true});
    }catch(error){next(error)}
  });
}
