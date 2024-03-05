import type { VisibleLanguageId } from '../../problems/problemData';
import { defaultLanguageId, visibleLanguageIds } from '../../problems/problemData';

const selectedLanguageIdKey = 'selectedLanguageId';

export const setLanguageIdToSessionStorage = (value: string): void => {
  sessionStorage.setItem(selectedLanguageIdKey, value);
};

export const getLanguageIdFromSessionStorage = (): VisibleLanguageId => {
  const languageId = sessionStorage.getItem(selectedLanguageIdKey);
  if (visibleLanguageIds.includes(languageId as VisibleLanguageId)) {
    return languageId as VisibleLanguageId;
  }
  return defaultLanguageId;
};
