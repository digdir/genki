export type SilentAuthorize = (authorizeUrl: string) => Promise<URL | undefined>;

export const isSilentCallback = (win: Window, callbackPath = '/callback') => {
  let framed: boolean;
  try {
    framed = win.self !== win.top;
  } catch {
    framed = true;
  }
  return framed && win.location.pathname === callbackPath;
};

export const silentFrame =
  (win: Window, callbackPath = '/callback', timeoutMs = 10_000): SilentAuthorize =>
  (authorizeUrl) =>
    new Promise((resolve) => {
      const frame = win.document.createElement('iframe');
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      const finish = (result?: URL) => {
        win.clearTimeout(timer);
        frame.removeEventListener('load', landed);
        frame.remove();
        resolve(result);
      };
      const landed = () => {
        let href: string | undefined;
        try {
          href = frame.contentWindow?.location.href;
        } catch {
          return;
        }
        if (!href || href === 'about:blank') return;
        const at = new URL(href);
        if (at.origin === win.location.origin && at.pathname === callbackPath) finish(at);
      };
      const timer = win.setTimeout(() => finish(), timeoutMs);
      frame.addEventListener('load', landed);
      frame.src = authorizeUrl;
      win.document.body.append(frame);
    });
