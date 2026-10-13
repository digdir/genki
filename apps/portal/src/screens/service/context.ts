import { createContext, useContext } from 'react';

export const ServicePageContext = createContext(false);

export const useInServicePage = () => useContext(ServicePageContext);
