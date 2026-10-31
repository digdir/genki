import { createContext, useContext } from 'react';

export const DeveloperView = createContext(true);

export const useDeveloperView = () => useContext(DeveloperView);
