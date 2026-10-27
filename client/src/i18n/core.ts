import en from "./en.json";
import ja from "./ja.json";

export const locales = ["zh-CN", "en", "ja"] as const;
export type Locale = typeof locales[number];
export type TranslationValues = Record<string, string | number>;
export const LOCALE_STORAGE_KEY = "alexandria:ui-language";
const catalogs: Record<Exclude<Locale, "zh-CN">, Record<string, string>> = { en, ja };

export function isLocale(value: unknown): value is Locale {
  return locales.includes(value as Locale);
}

export function readLocale(storage?: Pick<Storage, "getItem">): Locale {
  try {
    const value = (storage ?? (typeof window !== "undefined" ? window.localStorage : undefined))?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : "zh-CN";
  } catch { return "zh-CN"; }
}

let currentLocale: Locale = readLocale();
const listeners = new Set<() => void>();
export const getLocale = () => currentLocale;
export const getIntlLocale = () => currentLocale === "en" ? "en-US" : currentLocale === "ja" ? "ja-JP" : "zh-CN";
export const subscribeLocale = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function setLocale(locale: Locale, persist = true): void {
  if (!isLocale(locale)) return;
  if (persist) {
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Session-only selection still works. */ }
  }
  if (locale === currentLocale) return;
  currentLocale = locale;
  listeners.forEach(listener => listener());
}

export function translate(source: string, locale: Locale, values: TranslationValues = {}): string {
  const localized = locale === "zh-CN" ? source : catalogs[locale][source];
  const message = typeof localized === "string" ? localized : source;
  return message.replace(/\{\{(\w+)\}\}/g, (match, key: string) => Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

/** Source-language keys keep Chinese the explicit fallback. Never pass library metadata through this function. */
export function t(source: string, values?: TranslationValues): string {
  return translate(source, currentLocale, values);
}
