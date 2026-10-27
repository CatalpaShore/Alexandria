import { config } from "./config.js";

export type RuntimeMode = "local-pc" | "nas";
export type ClientMode = "web" | "android";

export type RuntimeCapabilities = {
  runtimeMode: RuntimeMode;
  clientMode: ClientMode;
  canManageIngestion: boolean;
  canTriggerScan: boolean;
  disabledReason: string | null;
};

const androidUserAgentPattern = /(?:AdultMediaWallAndroid\/|\bAndroid\b)/i;

export function getRuntimeCapabilities(
  userAgent = "",
  runtimeMode: RuntimeMode = config.runtimeMode
): RuntimeCapabilities {
  const clientMode: ClientMode = androidUserAgentPattern.test(userAgent) ? "android" : "web";
  const canManage = clientMode === "web" && !config.demoMode;
  const disabledReason = config.demoMode ? "公开 Demo 仅供浏览和播放，管理操作已禁用" : clientMode === "android"
    ? "安卓版仅支持浏览和播放，定时入库与手动扫描请在本地 PC 版操作"
    : null;

  return {
    runtimeMode,
    clientMode,
    canManageIngestion: canManage,
    canTriggerScan: canManage,
    disabledReason
  };
}
