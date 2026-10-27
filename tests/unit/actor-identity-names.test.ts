import { describe, expect, it } from "vitest";
import {
  normalizedActorIdentityNames,
  uniqueStableActorIdentityMatch
} from "../../scripts/lib/actor-identity-names";

describe("R18 actor identity names", () => {
  it("accepts an explicit parenthesized stage-name alias", () => {
    expect(normalizedActorIdentityNames("藤咲まい（藤咲舞）"))
      .toEqual(expect.arrayContaining(["藤咲まい藤咲舞", "藤咲舞"]));
    expect(normalizedActorIdentityNames("NAO(美竹すず)"))
      .toEqual(expect.arrayContaining(["nao美竹すず", "美竹すず"]));
    expect(normalizedActorIdentityNames("みひな （あずみひな、永井みひな）"))
      .toEqual(expect.arrayContaining(["あずみひな", "永井みひな"]));
  });

  it("accepts only the exact reversal of a two-token Latin name", () => {
    expect(normalizedActorIdentityNames("Mai Fujisaki"))
      .toEqual(expect.arrayContaining(["maifujisaki", "fujisakimai"]));
  });

  it("does not split unparenthesized descriptive text into identity aliases", () => {
    expect(normalizedActorIdentityNames("美由 25歳 歯科医師"))
      .toEqual(["美由25歳歯科医師"]);
  });

  it("selects exactly one named performer from a multi-performer product", () => {
    const candidates = [
      { id: "1", kanji: "葉月ひな", romaji: "Hina Hazuki" },
      { id: "2", kanji: "夢乃のあ", romaji: "Noa Yumeno" }
    ];
    expect(uniqueStableActorIdentityMatch("葉月ひな", candidates)?.id).toBe("1");
    expect(uniqueStableActorIdentityMatch("存在しない名前", candidates)).toBeNull();
  });

  it("rejects an ambiguous target instead of choosing the first candidate", () => {
    const candidates = [
      { id: "1", kanji: "NAO", romaji: "Nao" },
      { id: "2", kanji: "NAO", romaji: "Nao" }
    ];
    expect(uniqueStableActorIdentityMatch("NAO", candidates)).toBeNull();
  });
});
