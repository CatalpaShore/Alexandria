import type { Locale } from "../i18n/core";

export type ProductTourAsset = {
  video: string;
  poster: string;
  captions: string;
  captionLanguage: string;
  captionLabel: string;
};

/** Explicit assets only: never build a path from arbitrary locale input. */
export const productTours: Record<Locale, ProductTourAsset> = {
  "zh-CN": {
    video: "/tour/product-tour.mp4",
    poster: "/showcase/tour-poster.png",
    captions: "/tour/subtitles-zh.vtt",
    captionLanguage: "zh-CN",
    captionLabel: "简体中文"
  },
  en: {
    video: "/tour/product-tour-en.mp4",
    poster: "/showcase/tour-poster-en.png",
    captions: "/tour/subtitles-en.vtt",
    captionLanguage: "en",
    captionLabel: "English"
  },
  ja: {
    video: "/tour/product-tour-ja.mp4",
    poster: "/showcase/tour-poster-ja.png",
    captions: "/tour/subtitles-ja.vtt",
    captionLanguage: "ja",
    captionLabel: "日本語"
  }
};
