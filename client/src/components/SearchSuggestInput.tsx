import { t, useLocale, useLocalizedMemo } from "../i18n";
import { AutoComplete, Input, Tag, Typography } from "antd";
import type { InputRef } from "antd/es/input";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import {
  fetchSearchSuggestions,
  getPosterUrl,
  type SearchSuggestion,
  type SearchSuggestionType
} from "../lib/api";

type SearchSuggestInputProps = {
  value: string;
  inputRef?: RefObject<InputRef>;
  onChange: (value: string) => void;
  onSelectSuggestion: (suggestion: SearchSuggestion) => void;
};

const groupLabels: Record<SearchSuggestionType, string> = {
  get code() { return t("番号"); },
  get actor() { return t("演员"); },
  get maker() { return t("厂商"); },
  get genre() { return t("标签"); }
};

const SUGGESTION_DEBOUNCE_MS = 180;

function encodeSuggestion(suggestion: SearchSuggestion): string {
  return `${suggestion.type}:${encodeURIComponent(suggestion.value)}`;
}

function renderSuggestion(suggestion: SearchSuggestion) {
  return (
    <div className="search-suggestion">
      {suggestion.mediaId ? (
        <img
          alt=""
          loading="lazy"
          src={getPosterUrl(suggestion.mediaId)}
          onError={(event) => {
            event.currentTarget.style.opacity = "0";
          }}
        />
      ) : (
        <span className="search-suggestion-empty" />
      )}
      <span className="search-suggestion-copy">
        <Typography.Text strong>{suggestion.label}</Typography.Text>
        {suggestion.subtitle && (
          <Typography.Text type="secondary">{suggestion.subtitle}</Typography.Text>
        )}
      </span>
      <Tag>{suggestion.count}</Tag>
    </div>
  );
}

export function SearchSuggestInput({
  value,
  inputRef,
  onChange,
  onSelectSuggestion
}: SearchSuggestInputProps) {
  useLocale();
  const keyword = value.trim();
  const [focused, setFocused] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword);
    }, SUGGESTION_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [keyword]);
  const suggestions = useQuery({
    queryKey: ["search-suggestions", debouncedKeyword],
    queryFn: () => fetchSearchSuggestions(debouncedKeyword, 8),
    enabled: debouncedKeyword.length >= 2,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000
  });
  const allSuggestions = useLocalizedMemo(() => {
    const data = suggestions.data;
    if (!data) return [];
    return [...data.codes, ...data.actors, ...data.makers, ...data.genres];
  }, [suggestions.data]);
  const options = useLocalizedMemo(
    () =>
      ([
        ["code", suggestions.data?.codes ?? []],
        ["actor", suggestions.data?.actors ?? []],
        ["maker", suggestions.data?.makers ?? []],
        ["genre", suggestions.data?.genres ?? []]
      ] as Array<[SearchSuggestionType, SearchSuggestion[]]>)
        .filter(([, items]) => items.length > 0)
        .map(([type, items]) => ({
          label: <span className="search-suggestion-group">{t(groupLabels[type])}</span>,
          options: items.map((item) => ({
            value: encodeSuggestion(item),
            label: renderSuggestion(item)
          }))
        })),
    [suggestions.data]
  );

  return (
    <AutoComplete
      className="search-autocomplete"
      options={options}
      value={value}
      open={focused && suggestionsOpen && keyword.length >= 2}
      onFocus={() => { setFocused(true); setSuggestionsOpen(true); }}
      onBlur={() => setFocused(false)}
      onOpenChange={setSuggestionsOpen}
      onChange={(nextValue) => onChange(String(nextValue))}
      onSelect={(encodedValue) => {
        setSuggestionsOpen(false);
        const selected = allSuggestions.find((suggestion) => encodeSuggestion(suggestion) === encodedValue);
        if (selected) onSelectSuggestion(selected);
      }}
    >
      <Input
        allowClear
        className="search-input"
        prefix={<Search size={16} />}
        placeholder={t("搜索文件名、番号、演员或标签")}
        ref={inputRef}
      />
    </AutoComplete>
  );
}
