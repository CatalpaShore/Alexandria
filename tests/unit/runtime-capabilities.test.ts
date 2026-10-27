import { describe, expect, it } from "vitest";
import { getRuntimeCapabilities } from "../../server/src/runtimeCapabilities.js";

describe("runtime capabilities", () => {
  it("allows ingestion and scans from local and NAS web clients", () => {
    expect(getRuntimeCapabilities("Mozilla/5.0", "local-pc")).toMatchObject({
      canManageIngestion: true,
      canTriggerScan: true
    });
    expect(getRuntimeCapabilities("AdultMediaWallAndroid/1.0 Android", "local-pc")).toMatchObject({
      clientMode: "android",
      canManageIngestion: false,
      canTriggerScan: false
    });
    expect(getRuntimeCapabilities("Mozilla/5.0", "nas")).toMatchObject({
      runtimeMode: "nas",
      canManageIngestion: true,
      canTriggerScan: true,
      disabledReason: null
    });
    expect(getRuntimeCapabilities("AdultMediaWallAndroid/1.0 Android", "nas")).toMatchObject({
      clientMode: "android",
      canManageIngestion: false,
      canTriggerScan: false
    });
  });
});
