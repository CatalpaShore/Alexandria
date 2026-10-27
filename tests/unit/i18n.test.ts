import { afterEach, describe, expect, it } from "vitest";
import { getLocale, isLocale, LOCALE_STORAGE_KEY, readLocale, setLocale, subscribeLocale, t, translate } from "../../client/src/i18n/core";

afterEach(() => setLocale("zh-CN", false));
describe("interface language", () => {
  it("defaults to Chinese, including missing, invalid, and blocked browser storage", () => {
    expect(readLocale({ getItem: () => null })).toBe("zh-CN");
    expect(readLocale({ getItem: () => "fr" })).toBe("zh-CN");
    expect(readLocale({ getItem: () => { throw Error("blocked"); } })).toBe("zh-CN");
    expect(readLocale({ getItem: key => key === LOCALE_STORAGE_KEY ? "ja" : null })).toBe("ja");
    expect(isLocale("en")).toBe(true);
    expect(isLocale("en-US")).toBe(false);
  });
  it("notifies subscribers only on changes and can switch without browser persistence", () => {
    const changes: string[] = [];
    const stop = subscribeLocale(() => changes.push(getLocale()));
    setLocale("en", false); setLocale("en", false); setLocale("ja", false);
    stop(); setLocale("zh-CN", false);
    expect(changes).toEqual(["en", "ja"]);
  });
  it("translates interface messages, interpolates repeated values, and safely falls back", () => {
    expect(translate("媒体墙", "en")).toBe("Media wall");
    expect(translate("媒体墙", "ja")).toBe("メディアウォール");
    expect(translate("现有 {{count}} 条馆藏记录将保留", "en", { count: 7 })).toBe("Keep 7 existing library records");
    expect(translate("{{value}} / {{value}}", "ja", { value: "<tag>" })).toBe("<tag> / <tag>");
    expect(translate("unknown {{param}}", "en")).toBe("unknown {{param}}");
    expect(translate("constructor", "en")).toBe("constructor");
    setLocale("ja", false);
    expect(t("关闭播放器")).toBe("プレイヤーを閉じる");
  });
});
