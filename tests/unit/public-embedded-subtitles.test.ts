import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {describe,expect,it} from "vitest";
import {listEmbeddedSubtitles,extractEmbeddedText} from "../../server/src/embeddedSubtitleTracks.js";
describe("embedded native subtitle tracks",()=>{
 it("lists and extracts a neutral MKV SRT track without changing the media file",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"alexandria-embedded-")),sub=path.join(root,"test.srt"),video=path.join(root,"test.mkv");fs.writeFileSync(sub,"1\n00:00:00,000 --> 00:00:01,500\nNeutral embedded subtitle\n");
  try{execFileSync("ffmpeg",["-nostdin","-v","error","-f","lavfi","-i","color=c=blue:s=160x90:r=5:d=2","-i",sub,"-map","0:v","-map","1:s","-c:v","libx264","-threads","1","-c:s","srt","-metadata:s:s:0","language=eng",video]);const before=fs.readFileSync(video);const tracks=await listEmbeddedSubtitles(video);expect(tracks[0]).toMatchObject({codec:"subrip",language:"eng",supported:true});expect(await extractEmbeddedText(video,tracks[0].index)).toContain("Neutral embedded subtitle");expect(fs.readFileSync(video)).toEqual(before);await expect(extractEmbeddedText(video,999)).rejects.toThrow("OCR");}finally{fs.rmSync(root,{recursive:true,force:true})}
 });
});
