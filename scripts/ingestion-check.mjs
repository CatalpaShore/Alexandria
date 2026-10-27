import assert from "node:assert/strict";
import {
  getIngestionRejectionReason,
  normalizeIngestionFilename
} from "../dist/server/ingestionFiles.js";
import { getRuntimeCapabilities } from "../dist/server/runtimeCapabilities.js";

const known = new Set(["ABP", "YMDD", "WAAA", "T38", "LD", "SGKI", "MIUM", "LUXU", "SSNI", "JUY", "IPZ"]);
const cases = [
  ["4k2.com@abp-537ch.mp4", "ABP-537-C.mp4"],
  ["ymdd-473ch.mp4", "YMDD-473-C.mp4"],
  ["WAAA666-U.mkv", "WAAA-666-U.mkv"],
  ["FC2PPV-4755237-2.mp4", "FC2-PPV-4755237-2.mp4"],
  ["T38-3.mp4", "T38-003.mp4"],
  ["LD-018.m4v", "LD-018.m4v"],
  ["4k2.me@sgki-093a.mp4", "SGKI-093.mp4"],
  ["300MIUM-821.mp4", "MIUM-821.mp4"],
  ["hhd800.com@259LUXU-1888.mp4", "LUXU-1888.mp4"],
  ["0220【抖音、微博@novelpaper】ssni780prat3.mp4", "SSNI-780.mp4"],
  ["xhd1080.com@juy00101hhb.mp4", "JUY-101.mp4"],
  ["xhd1080.com@ipz00904hhb.mp4", "IPZ-904.mp4"]
];

for (const [input, expected] of cases) {
  assert.equal(normalizeIngestionFilename(input, known)?.normalizedName, expected, input);
}
assert.equal(normalizeIngestionFilename("VID_20250713.mp4", known), null);
assert.equal(normalizeIngestionFilename("unrelated-course-1080.mp4", known), null);
assert.equal(normalizeIngestionFilename("cE3s7UeooPU.mp4", new Set(["CE"])), null);
assert.equal(normalizeIngestionFilename("BMjAxOTA2MTkxMTA2NTRfMzM4MzExNjlfMTQyMjUxMDcxNTFfMV8z_b_Ba1e8266b30e583ff30d8a74ed0bc2962.mp4", new Set(["BA"])), null);
assert.equal(normalizeIngestionFilename("Eden Ivy Flexible Cumslut Gets Hardcore And Intense Dp With Balls Deep Anal Pounding In Crazy Flexible Positions Ld018 (23-07-2021) 1080P-1.m4v", new Set(["LD"])), null);
assert.equal(normalizeIngestionFilename("Myfans（kento_ntr76）Kento private video.mp4", new Set(["NTR"])), null);
assert.equal(normalizeIngestionFilename("191030-after-being-a-very-naughty-girl-for-my-400-fans-i-had-to-be-punished.mp4", new Set(["MY"])), null);
assert.equal(normalizeIngestionFilename("2048.cc-发现个新的乐趣和推友语音玩SS_1522181923984273408_0_720x1280.mp4", new Set(["SS"])), null);
assert.equal(normalizeIngestionFilename("267-Misa-1080p.mp4", new Set(["MISA"])), null);
assert.equal(normalizeIngestionFilename("My 1st Gloryhole.mp4", new Set(["MY"])), null);
assert.equal(normalizeIngestionFilename("P3GD-CD45Z4.mp4", new Set(["CD"])), null);

const rejectedCases = [
  ["Myfans（kento_ntr76）Kento private video.mp4", new Set(["NTR"]), "blocked-platform-keyword"],
  ["Eden Ivy Flexible Cumslut Gets Hardcore And Intense Dp With Balls Deep Anal Pounding In Crazy Flexible Positions Ld018 (23-07-2021) 1080P-1.m4v", new Set(["LD"]), "descriptive-english-title"],
  ["BMjAxOTA2MTkxMTA2NTRfMzM4MzExNjlfMTQyMjUxMDcxNTFfMV8z_b_Ba1e8266b30e583ff30d8a74ed0bc2962.mp4", new Set(["BA"]), "opaque-random-name"],
  ["cE3s7UeooPU.mp4", new Set(["CE"]), "invalid-code-boundary"],
  ["FC220203972175.mp4", new Set(["FC2"]), "invalid-code-boundary"]
];
for (const [filename, prefixes, expected] of rejectedCases) {
  assert.equal(getIngestionRejectionReason(filename, prefixes), expected, filename);
}
assert.equal(getIngestionRejectionReason("unrelated-course-1080.mp4", known), null);

assert.deepEqual(
  getRuntimeCapabilities("Mozilla/5.0 Desktop", "local-pc"),
  {
    runtimeMode: "local-pc",
    clientMode: "web",
    canManageIngestion: true,
    canTriggerScan: true,
    disabledReason: null
  }
);
assert.equal(getRuntimeCapabilities("AdultMediaWallAndroid/0.1.3", "local-pc").canManageIngestion, false);
assert.equal(getRuntimeCapabilities("Mozilla/5.0 Android", "local-pc").canTriggerScan, false);
assert.equal(getRuntimeCapabilities("Mozilla/5.0 Desktop", "nas").canManageIngestion, false);

console.log(`Ingestion and runtime checks passed: ${cases.length + 21}`);
