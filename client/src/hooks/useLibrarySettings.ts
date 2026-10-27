import { t, useLocale } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { message } from "antd";
import { useEffect, useState } from "react";
import { fetchLibraryPaths, updateLibraryPaths } from "../lib/api";

export function useLibrarySettings(options: {
  enabled?: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  useLocale();
  const queryClient = useQueryClient();
  const [libraryPathDraft, setLibraryPathDraft] = useState<[string, string]>(["", ""]);
  const libraryPaths = useQuery({
    queryKey: ["library-paths"],
    queryFn: fetchLibraryPaths,
    enabled: options.enabled ?? true
  });
  const saveLibraryPaths = useMutation({
    mutationFn: () => updateLibraryPaths([libraryPathDraft[0].trim(), libraryPathDraft[1].trim()]),
    onSuccess: async (data) => {
      message.success(t("资源路径已保存"));
      options.setOpen(false);
      setLibraryPathDraft([data.roots[0]?.path ?? "", data.roots[1]?.path ?? ""]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["library-paths"] }),
        queryClient.invalidateQueries({ queryKey: ["facets"] }),
        queryClient.invalidateQueries({ queryKey: ["health-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["media"] })
      ]);
    }
  });

  useEffect(() => {
    if (!libraryPaths.data || options.open) return;
    setLibraryPathDraft([
      libraryPaths.data.roots[0]?.path ?? "",
      libraryPaths.data.roots[1]?.path ?? ""
    ]);
  }, [libraryPaths.data, options.open]);

  function openLibrarySettings() {
    saveLibraryPaths.reset();
    setLibraryPathDraft([
      libraryPaths.data?.roots[0]?.path ?? libraryPathDraft[0],
      libraryPaths.data?.roots[1]?.path ?? libraryPathDraft[1]
    ]);
    options.setOpen(true);
  }

  return {
    libraryPaths,
    libraryPathDraft,
    setLibraryPathDraft,
    saveLibraryPaths,
    openLibrarySettings
  };
}
