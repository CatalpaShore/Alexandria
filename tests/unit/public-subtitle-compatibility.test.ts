import {describe,expect,it} from "vitest";
import {decodeText,subtitleToVtt} from "../../server/src/services/subtitleService.js";
describe("subtitle text compatibility",()=>{
 it("uses the ASS Events format rather than the preceding Styles format",()=>{
  const vtt=subtitleToVtt('[V4+ Styles]\nFormat: Name, Fontname, Fontsize\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.50,Default,,0,0,0,,{\\b1}Hello, world\\NNext line',"ass");
  expect(vtt).toContain("00:00:01.200 --> 00:00:03.500\nHello, world\nNext line");
 });
 it("decodes BOMs and explicit GB18030, rejects ambiguous byte guessing",()=>{
  expect(decodeText(Buffer.from([0xff,0xfe,0x2d,0x4e]))).toBe("中");expect(decodeText(Buffer.from([0xd6,0xd0]),"gb18030")).toBe("中");expect(()=>decodeText(Buffer.from([0xd6,0xd0]))).toThrow("ambiguous");
 });
 it("converts SRT timing and retains valid VTT",()=>{
  expect(subtitleToVtt("1\n00:00:00,500 --> 00:00:02,000\nDemo subtitle","srt")).toContain("00:00:00.500 --> 00:00:02.000");expect(subtitleToVtt("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nText","vtt")).toContain("Text");
 });
});
