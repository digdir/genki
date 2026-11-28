import { createContext, useContext, type ReactNode } from 'react';

export const PageTabsContext = createContext<ReactNode>(null);

export const PageTabs = () => <>{useContext(PageTabsContext)}</>;
