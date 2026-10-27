import { describe, expect, it } from "vitest";
import { findActiveSubtitleText, hasNativeChineseSubtitle, parseWebVtt } from "../../client/src/lib/subtitles.js";

describe("播放器字幕", () => {
  it("解析 WebVTT 并忽略零时长片段", () => {
    const cues = parseWebVtt(`WEBVTT\n\n00:05:40.640 --> 00:05:45.280\n中文字幕\n\n00:06:00.000 --> 00:06:00.000\n无效字幕\n`);

    expect(cues).toEqual([
      { start: 340.64, end: 345.28, text: "中文字幕" }
    ]);
  });

  it("只在对应播放时间返回字幕", () => {
    const cues = [
      { start: 340.64, end: 345.28, text: "第一句" },
      { start: 346, end: 349, text: "第二句" }
    ];

    expect(findActiveSubtitleText(cues, 342.596)).toBe("第一句");
    expect(findActiveSubtitleText(cues, 345.5)).toBe("");
    expect(findActiveSubtitleText(cues, 346.5)).toBe("第二句");
  });

  it("检测到原生中文字幕时默认隐藏 AI 字幕", () => {
    expect(hasNativeChineseSubtitle([{ language: "zh-CN", label: "简体中文" }], "speech")).toBe(true);
    expect(hasNativeChineseSubtitle([{ language: "ja", label: "Japanese" }], "existing-chinese")).toBe(true);
    expect(hasNativeChineseSubtitle([{ language: "ja", label: "Japanese" }], "embedded")).toBe(false);
  });
});
