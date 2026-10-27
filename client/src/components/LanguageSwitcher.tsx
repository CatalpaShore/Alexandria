import { Select } from "antd";
import { Languages } from "lucide-react";
import { setLocale, t, useLocale } from "../i18n";

export function LanguageSwitcher() {
  const locale = useLocale();
  return <div className="ui-language-switcher">
    <Languages size={15} aria-hidden="true" />
    <Select
      aria-label={t("界面语言")}
      className="ui-language-select"
      popupMatchSelectWidth={false}
      value={locale}
      onChange={value => setLocale(value)}
      options={[{ value: "zh-CN", label: "中文" }, { value: "en", label: "English" }, { value: "ja", label: "日本語" }]}
    />
  </div>;
}
