import { useEffect, type RefObject } from "react";
import type { InputRef } from "antd";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

export function useGlobalShortcuts(
  searchInputRef: RefObject<InputRef>,
  onRandomDiscovery: () => void
) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus({ cursor: "all" });
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        onRandomDiscovery();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onRandomDiscovery, searchInputRef]);
}
