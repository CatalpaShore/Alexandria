import { describe, expect, it } from "vitest";
import { classifyCompatibility } from "../../server/src/mediaProbe";

describe("media playback compatibility", () => {
  it("keeps portable browser codecs on the native path", () => {
    expect(classifyCompatibility("mp4", "mov", "h264", "aac")).toBe("native");
    expect(classifyCompatibility("webm", "matroska", "vp9", "opus")).toBe("native");
  });

  it("transcodes HEVC instead of accepting audio-only playback", () => {
    expect(classifyCompatibility("mp4", "mov", "hevc", "aac")).toBe("transcode");
  });

  it("uses remux only when the codecs are portable", () => {
    expect(classifyCompatibility("mkv", "matroska", "h264", "aac")).toBe("remux");
    expect(classifyCompatibility("mkv", "matroska", "hevc", "aac")).toBe("transcode");
  });
});
