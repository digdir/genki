import { useEffect } from 'react';

export const priceSegment = 'price-and-terms';
export const pricePath = `#/about/${priceSegment}`;

export const siteName = 'Genki';

export const useDocumentTitle = (title: string, whole = false) => {
  useEffect(() => {
    document.title = whole ? title : `${title} | ${siteName}`;
  }, [title, whole]);
};
