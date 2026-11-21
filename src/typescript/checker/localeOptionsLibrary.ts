// Type-only locale declarations and their dependencies from TypeScript 7.0.2's ECMAScript libraries.
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.
// oxfmt-ignore
export const LOCALE_OPTIONS_LIBRARY = `
interface NumberFormatOptions {
    localeMatcher?: "lookup" | "best fit" | undefined;
    style?: NumberFormatOptionsStyle | undefined;
    currency?: string | undefined;
    currencyDisplay?: NumberFormatOptionsCurrencyDisplay | undefined;
    useGrouping?: NumberFormatOptionsUseGrouping | undefined;
    minimumIntegerDigits?: number | undefined;
    minimumFractionDigits?: number | undefined;
    maximumFractionDigits?: number | undefined;
    minimumSignificantDigits?: number | undefined;
    maximumSignificantDigits?: number | undefined;
}
interface NumberFormatOptions {
    numberingSystem?: string | undefined;
    compactDisplay?: "short" | "long" | undefined;
    notation?: "standard" | "scientific" | "engineering" | "compact" | undefined;
    signDisplay?: NumberFormatOptionsSignDisplay | undefined;
    unit?: string | undefined;
    unitDisplay?: "short" | "long" | "narrow" | undefined;
    currencySign?: "standard" | "accounting" | undefined;
}
interface NumberFormatOptions {
    roundingPriority?: "auto" | "morePrecision" | "lessPrecision" | undefined;
    roundingIncrement?: 1 | 2 | 5 | 10 | 20 | 25 | 50 | 100 | 200 | 250 | 500 | 1000 | 2000 | 2500 | 5000 | undefined;
    roundingMode?: "ceil" | "floor" | "expand" | "trunc" | "halfCeil" | "halfFloor" | "halfExpand" | "halfTrunc" | "halfEven" | undefined;
    trailingZeroDisplay?: "auto" | "stripIfInteger" | undefined;
}
interface CollatorOptions {
    usage?: "sort" | "search" | undefined;
    localeMatcher?: "lookup" | "best fit" | undefined;
    numeric?: boolean | undefined;
    caseFirst?: "upper" | "lower" | "false" | undefined;
    sensitivity?: "base" | "accent" | "case" | "variant" | undefined;
    collation?: "big5han" | "compat" | "default" | "dict" | "direct" | "ducet" | "emoji" | "eor" | "gb2312" | "phonebk" | "phonetic" | "pinyin" | "reformed" | "searchjl" | "stroke" | "trad" | "unihan" | "zhuyin" | undefined;
    ignorePunctuation?: boolean | undefined;
}
interface DateTimeFormatOptions {
    localeMatcher?: "best fit" | "lookup" | undefined;
    weekday?: "long" | "short" | "narrow" | undefined;
    era?: "long" | "short" | "narrow" | undefined;
    year?: "numeric" | "2-digit" | undefined;
    month?: "numeric" | "2-digit" | "long" | "short" | "narrow" | undefined;
    day?: "numeric" | "2-digit" | undefined;
    hour?: "numeric" | "2-digit" | undefined;
    minute?: "numeric" | "2-digit" | undefined;
    second?: "numeric" | "2-digit" | undefined;
    timeZoneName?: "short" | "long" | "shortOffset" | "longOffset" | "shortGeneric" | "longGeneric" | undefined;
    formatMatcher?: "best fit" | "basic" | undefined;
    hour12?: boolean | undefined;
    timeZone?: string | undefined;
}
interface DateTimeFormatOptions {
    calendar?: string | undefined;
    dayPeriod?: "narrow" | "short" | "long" | undefined;
    numberingSystem?: string | undefined;
    dateStyle?: "full" | "long" | "medium" | "short" | undefined;
    timeStyle?: "full" | "long" | "medium" | "short" | undefined;
    hourCycle?: "h11" | "h12" | "h23" | "h24" | undefined;
}
interface DateTimeFormatOptions {
    formatMatcher?: "basic" | "best fit" | "best fit" | undefined;
    dateStyle?: "full" | "long" | "medium" | "short" | undefined;
    timeStyle?: "full" | "long" | "medium" | "short" | undefined;
    dayPeriod?: "narrow" | "short" | "long" | undefined;
    fractionalSecondDigits?: 1 | 2 | 3 | undefined;
}
type LocalesArgument = UnicodeBCP47LocaleIdentifier | Locale | readonly (UnicodeBCP47LocaleIdentifier | Locale)[] | undefined;
type NumberFormatOptionsStyle = keyof NumberFormatOptionsStyleRegistry;
type NumberFormatOptionsCurrencyDisplay = keyof NumberFormatOptionsCurrencyDisplayRegistry;
type NumberFormatOptionsUseGrouping = {} extends NumberFormatOptionsUseGroupingRegistry ? boolean : keyof NumberFormatOptionsUseGroupingRegistry | "true" | "false" | boolean;
type NumberFormatOptionsSignDisplay = keyof NumberFormatOptionsSignDisplayRegistry;
type UnicodeBCP47LocaleIdentifier = string;
interface Locale extends LocaleOptions {
    baseName: string;
    language: string;
    maximize(): Locale;
    minimize(): Locale;
    toString(): UnicodeBCP47LocaleIdentifier;
}
interface NumberFormatOptionsStyleRegistry {
    decimal: never;
    percent: never;
    currency: never;
}
interface NumberFormatOptionsStyleRegistry {
    unit: never;
}
interface NumberFormatOptionsCurrencyDisplayRegistry {
    code: never;
    symbol: never;
    name: never;
}
interface NumberFormatOptionsCurrencyDisplayRegistry {
    narrowSymbol: never;
}
interface NumberFormatOptionsUseGroupingRegistry {}
interface NumberFormatOptionsUseGroupingRegistry {
    min2: never;
    auto: never;
    always: never;
}
interface NumberFormatOptionsSignDisplayRegistry {
    auto: never;
    never: never;
    always: never;
    exceptZero: never;
}
interface NumberFormatOptionsSignDisplayRegistry {
    negative: never;
}
interface LocaleOptions {
    baseName?: string;
    calendar?: string;
    caseFirst?: LocaleCollationCaseFirst;
    collation?: string;
    hourCycle?: LocaleHourCycleKey;
    language?: string;
    numberingSystem?: string;
    numeric?: boolean;
    region?: string;
    script?: string;
}
type LocaleCollationCaseFirst = "upper" | "lower" | "false";
type LocaleHourCycleKey = "h12" | "h23" | "h11" | "h24";
`;
