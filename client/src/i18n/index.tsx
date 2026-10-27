import { useEffect, useMemo, useSyncExternalStore, type DependencyList, type ReactNode } from "react";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import jaJP from "antd/locale/ja_JP";
import { appTheme } from "../appTheme";
import { getLocale, LOCALE_STORAGE_KEY, readLocale, setLocale, subscribeLocale } from "./core";
export * from "./core";

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, () => "zh-CN" as const);
}

/** Memoize UI values while also invalidating them when the interface language changes. */
export function useLocalizedMemo<T>(factory: () => T, dependencies: DependencyList): T {
  const locale = useLocale();
  // Consumer dependencies are checked by ESLint's additionalHooks configuration.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, [locale, ...dependencies]);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = locale === "zh-CN" ? "Alexandria 18+ · 个人影库" : locale === "ja" ? "Alexandria 18+ · 個人ライブラリ" : "Alexandria 18+ · Personal library";
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY || event.key === null) setLocale(readLocale(), false);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [locale]);
  return <ConfigProvider theme={appTheme} locale={locale === "en" ? enUS : locale === "ja" ? jaJP : zhCN}>{children}</ConfigProvider>;
}
