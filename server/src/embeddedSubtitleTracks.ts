import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import type {Express} from "express";
import {db,type MediaRow} from "./db.js";
import {config} from "./config.js";
import {ensureInsideMediaRoot,streamFile} from "./services/fileStreaming.js";
const exec=promisify(execFile);
const textCodecs=new Set(["subrip","ass","ssa","webvtt","mov_text","text"]);
export type EmbeddedTrack={index:number;codec:string;language:string;title:string;supported:boolean};
const cached=new Map<string,EmbeddedTrack[]>();
const active=new Map<string,Promise<string>>();

export async function listEmbeddedSubtitles(file:string):Promise<EmbeddedTrack[]>{
 const stat=await fs.stat(file),key=`${file}\0${stat.size}\0${stat.mtimeMs}`;
 const known=cached.get(key);if(known)return known;
 const {stdout}=await exec("ffprobe",["-v","error","-protocol_whitelist","file,pipe","-select_streams","s","-show_entries","stream=index,codec_name:stream_tags=language,title","-of","json",file],{timeout:20000,maxBuffer:256000});
 const payload=JSON.parse(stdout) as {streams?:Array<{index:number;codec_name:string;tags?:{language?:string;title?:string}}>};
 const tracks=(payload.streams??[]).slice(0,20).map(s=>({index:s.index,codec:s.codec_name,language:s.tags?.language??"und",title:s.tags?.title??"",supported:textCodecs.has(s.codec_name)}));
 if(cached.size>=256)cached.delete(cached.keys().next().value!);cached.set(key,tracks);return tracks;
}
export async function extractEmbeddedText(file:string,index:number):Promise<string>{
 const track=(await listEmbeddedSubtitles(file)).find(s=>s.index===index);
 if(!track?.supported)throw new Error("This subtitle track requires OCR or an unsupported decoder");
 const {stdout}=await exec("ffmpeg",["-nostdin","-v","error","-protocol_whitelist","file,pipe","-i",file,"-map",`0:${index}`,"-threads","1","-f","webvtt","pipe:1"],{timeout:45000,maxBuffer:16*1024*1024});
 if(!stdout.startsWith("WEBVTT"))throw new Error("No text subtitles found");return stdout;
}
export function registerEmbeddedSubtitleRoutes(app:Express):void{
 const media=(id:string)=>db.prepare("SELECT * FROM media_files WHERE id=?").get(id) as MediaRow|undefined;
 app.get("/api/media/:id/subtitles/embedded",async(req,res,next)=>{try{const item=media(req.params.id);if(!item)return void res.sendStatus(404);ensureInsideMediaRoot(item.absolute_path);res.json({items:await listEmbeddedSubtitles(item.absolute_path)});}catch(error){next(error)}});
 app.get("/api/media/:id/subtitles/embedded/:index.vtt",async(req,res,next)=>{try{
  const item=media(req.params.id),index=Number(req.params.index);if(!item)return void res.sendStatus(404);if(!Number.isInteger(index)||index<0)return void res.sendStatus(400);ensureInsideMediaRoot(item.absolute_path);
  const key=crypto.createHash("sha256").update(`${item.id}:${item.size}:${item.mtime_ms}:${index}`).digest("hex"),dir=path.join(config.derivativeDir,"subtitles","embedded"),output=path.join(dir,key+".vtt");
  try{await fs.access(output);}catch{
   let work=active.get(key);if(!work){if(active.size>=2)return void res.status(503).set("Retry-After","2").end();work=(async()=>{const text=await extractEmbeddedText(item.absolute_path,index);await fs.mkdir(dir,{recursive:true});await fs.writeFile(output+".tmp",text);await fs.rename(output+".tmp",output);return output})();active.set(key,work);}
   try{await work;}finally{active.delete(key)}
  }
  streamFile(output,"text/vtt; charset=utf-8",req,res);
 }catch(error){next(error)}});
}
