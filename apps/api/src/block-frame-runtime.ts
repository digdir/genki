import { createHash } from 'node:crypto';

/** The bridge runtime every code block's frame loads before its bundle; served as fixed text. */
export const blockRuntime = String.raw`(function () {
  'use strict';
  if (window.parent === window || typeof MessageChannel !== 'function') return;
  var channel = new MessageChannel();
  var port = channel.port1;
  var renderers = [];
  var view = null;
  var resizedByBlock = false;
  var themeValue = /^[#(),.%\sa-zA-Z0-9-]{1,64}$/;
  var isPlain = function (v) {
    return typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
  };
  var isRender = function (m) {
    return isPlain(m) && m.genki === 1 && m.type === 'render' &&
      typeof m.state === 'string' && typeof m.locale === 'string' && typeof m.colorScheme === 'string' &&
      isPlain(m.theme) && isPlain(m.props) && isPlain(m.texts) && isPlain(m.data);
  };
  var applyTheme = function (theme, scheme) {
    var root = document.documentElement;
    for (var name in theme) {
      if (Object.prototype.hasOwnProperty.call(theme, name) && name.indexOf('--ds-') === 0 &&
          typeof theme[name] === 'string' && themeValue.test(theme[name]))
        root.style.setProperty(name, theme[name]);
    }
    root.setAttribute('data-color-scheme', scheme === 'dark' ? 'dark' : 'light');
  };
  var call = function (renderer) {
    try { renderer(view); } catch (error) { console.error(error); }
  };
  var clamp = function (h) {
    return Math.min(2000, Math.max(0, Math.ceil(h)));
  };
  port.onmessage = function (event) {
    if (!isRender(event.data)) return;
    var m = event.data;
    applyTheme(m.theme, m.colorScheme);
    view = { state: m.state, locale: m.locale, colorScheme: m.colorScheme, props: m.props, texts: m.texts, data: m.data };
    for (var i = 0; i < renderers.length; i++) call(renderers[i]);
  };
  Object.defineProperty(window, 'genki', {
    value: Object.freeze({
      onRender: function (renderer) {
        if (typeof renderer !== 'function') return;
        renderers.push(renderer);
        if (view) call(renderer);
      },
      emit: function (name, payload) {
        if (view) port.postMessage({ genki: 1, type: 'event', name: name, payload: payload });
      },
      resize: function (h) {
        resizedByBlock = true;
        port.postMessage({ genki: 1, type: 'resize', height: clamp(h) });
      }
    })
  });
  window.parent.postMessage({ genki: 1, type: 'ready' }, '*', [channel.port2]);
  window.addEventListener('load', function () {
    if (typeof ResizeObserver === 'function' && document.body)
      new ResizeObserver(function () {
        if (!resizedByBlock)
          port.postMessage({ genki: 1, type: 'resize', height: clamp(document.documentElement.getBoundingClientRect().height) });
      }).observe(document.body);
  });
})();
`;

/** The runtime's address holds its hash, so a cached copy is never stale. */
export const blockRuntimePath = `/runtime/${createHash('sha256').update(blockRuntime, 'utf8').digest('hex').slice(0, 16)}.js`;
