import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { productTours } from "../../client/src/lib/productTour";
import { locales } from "../../client/src/i18n/core";

describe("localized product tour assets", () => {
  it("maps every interface language to its own explicit video, poster and caption track", () => {
    expect(Object.keys(productTours)).toEqual([...locales]);
    expect(new Set(locales.map(locale => productTours[locale].video)).size).toBe(3);
    for (const locale of locales) {
      const asset = productTours[locale];
      expect(asset.captionLanguage).toBe(locale);
      expect(asset.captionLabel.length).toBeGreaterThan(0);
      expect(asset.video).toBe(locale === "zh-CN" ? "/tour/product-tour.mp4" : `/tour/product-tour-${locale}.mp4`);
      expect(asset.captions).toBe(`/tour/subtitles-${locale === "zh-CN" ? "zh" : locale}.vtt`);
    }
  });
  it("ships exact reviewed bytes for each localized asset", () => {
    const reviewed = JSON.parse(fs.readFileSync("docs/public-assets.json", "utf8")) as Record<string, { sha256: string }>;
    for (const locale of locales) for (const url of [productTours[locale].video, productTours[locale].poster, productTours[locale].captions]) {
      const file = path.posix.join("client/public", url);
      expect(reviewed[file], file).toBeDefined();
      expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), file).toBe(reviewed[file].sha256);
    }
  });
  it("includes complete, ordered narration cues in each caption language", () => {
    for (const locale of locales) {
      const text = fs.readFileSync(path.posix.join("client/public", productTours[locale].captions), "utf8");
      expect(text.startsWith("WEBVTT")).toBe(true);
      // WebVTT permits both mm:ss.mmm and hh:mm:ss.mmm timestamps.
      const cues = [...text.matchAll(/((?:\d{2}:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\r?\n([^\r\n]+)/g)];
      const seconds = (timestamp: string) => timestamp.split(":").reduce((total, value) => total * 60 + Number(value), 0);
      expect(cues.length, locale).toBe(27);
      let previousEnd = 0;
      for (const cue of cues) {
        const start = seconds(cue[1]);
        const end = seconds(cue[2]);
        expect(start).toBeGreaterThanOrEqual(previousEnd);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThan(139);
        expect(cue[3].trim().length).toBeGreaterThan(0);
        previousEnd = end;
      }
    }
  });
});
