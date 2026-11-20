const storedScheme = () => {
  try {
    return globalThis.localStorage.getItem('assistant.colorScheme');
  } catch {
    return null;
  }
};
const scheme = storedScheme();
if (scheme === 'light' || scheme === 'dark')
  globalThis.document.documentElement.dataset.colorScheme = scheme;
