const selectedLanguageIdKey = 'selectedLanguageId';

export const setLanguageIdToSessionStorage = (value: string): void => {
  sessionStorage.setItem(selectedLanguageIdKey, value);
};

export const getLanguageIdFromSessionStorage = (): string => {
  // デフォルトはJava
  return sessionStorage.getItem(selectedLanguageIdKey) || 'java';
};
