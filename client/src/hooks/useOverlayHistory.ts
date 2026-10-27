import { useCallback, useEffect, useRef } from "react";

export function useOverlayHistory(open: boolean, key: string, onBack: () => void) {
  const activeRef = useRef(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (open && !activeRef.current) {
      activeRef.current = true;
      window.history.pushState({ ...window.history.state, amwOverlay: key }, "");
    } else if (!open) {
      activeRef.current = false;
    }
  }, [key, open]);

  useEffect(() => {
    function handlePopState() {
      if (!activeRef.current || window.history.state?.amwOverlay === key) return;
      activeRef.current = false;
      onBackRef.current();
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [key]);

  return useCallback(() => {
    if (activeRef.current && window.history.state?.amwOverlay === key) {
      window.history.back();
      return;
    }
    activeRef.current = false;
    onBackRef.current();
  }, [key]);
}
