import { useLocale } from '@genai/i18n/react';
import { useEffect } from 'react';
import { routingOptions } from './router';

export const useContentLang = (): 'nb' | undefined =>
  useLocale().locale === 'nb' ? undefined : 'nb';

export const useUiLang = (): string | undefined => {
  const { locale } = useLocale();
  return locale === 'nb' ? undefined : locale;
};

export const documentTitle = (title: string): string => {
  const site = routingOptions().siteName;
  return !title || title === site ? site : `${title} | ${site}`;
};

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = documentTitle(title);
  }, [title]);
}
