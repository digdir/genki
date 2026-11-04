import { MotionConfig } from 'motion/react';
import { createContext, useContext, type ReactNode } from 'react';

export type Scheme = 'light' | 'dark';

const SchemeContext = createContext<Scheme | undefined>(undefined);

export const useScheme = () => useContext(SchemeContext);

export function DocsSiteRoot({
  scheme,
  className,
  children,
}: {
  scheme?: Scheme | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <SchemeContext.Provider value={scheme}>
      <MotionConfig reducedMotion="user">
        <div
          className={`docs-site${className ? ` ${className}` : ''}`}
          {...(scheme ? { 'data-color-scheme': scheme } : {})}
        >
          {children}
        </div>
      </MotionConfig>
    </SchemeContext.Provider>
  );
}
