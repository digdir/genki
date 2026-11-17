export type Theme = 'light' | 'dark' | 'auto';

const key = 'genai.theme';
const themes: readonly Theme[] = ['light', 'dark', 'auto'];

export const storedTheme = (): Theme => {
  try {
    const value = window.localStorage.getItem(key);
    return themes.find((t) => t === value) ?? 'auto';
  } catch {
    return 'auto';
  }
};

export const applyTheme = (theme: Theme) => {
  document.documentElement.setAttribute('data-color-scheme', theme);
};

export const saveTheme = (theme: Theme) => {
  applyTheme(theme);
  try {
    window.localStorage.setItem(key, theme);
    return true;
  } catch {
    return false;
  }
};
