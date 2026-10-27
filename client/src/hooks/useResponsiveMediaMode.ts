import { Grid } from "antd";
import { useEffect, useState } from "react";
import type { ContentMode } from "../app/types";

export function useResponsiveMediaMode(contentMode: ContentMode) {
  const [mobileViewMode, setMobileViewMode] = useState<"grid" | "reel">("grid");
  const [isPortrait, setIsPortrait] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia("(orientation: portrait)").matches
  );
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.lg ?? true;
  const canUseReelMode = !isDesktop && isPortrait;
  const isReelMode = contentMode === "wall" && canUseReelMode && mobileViewMode === "reel";

  useEffect(() => {
    const mediaQuery = window.matchMedia("(orientation: portrait)");
    const updateOrientation = () => setIsPortrait(mediaQuery.matches);

    updateOrientation();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", updateOrientation);
      return () => mediaQuery.removeEventListener("change", updateOrientation);
    }

    mediaQuery.addListener(updateOrientation);
    return () => mediaQuery.removeListener(updateOrientation);
  }, []);

  useEffect(() => {
    if (!canUseReelMode && mobileViewMode === "reel") setMobileViewMode("grid");
  }, [canUseReelMode, mobileViewMode]);

  return { mobileViewMode, setMobileViewMode, isDesktop, canUseReelMode, isReelMode };
}
