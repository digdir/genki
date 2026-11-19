import {
  ApiError,
  citedIndexes,
  currentSession,
  finishLogin,
  genki,
  loginUrl,
  logoutUrl,
  sourceFor,
  type Config,
  type Deps,
  type Source,
} from './genki.js';

const config = (await (await fetch('/config.json')).json()) as Config;
const deps: Deps = { fetch: (...args) => fetch(...args), storage: sessionStorage };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element<HTMLParagraphElement>('status');

const show = (message: string) => {
  status.textContent = message;
};

const fail = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) location.assign('/');
  else show(error instanceof Error ? error.message : String(error));
};

const isWebLink = (url: string | undefined): url is string => !!url && /^https?:\/\//.test(url);

const renderSources = (list: HTMLOListElement, text: string, sources: Source[]) => {
  list.replaceChildren();
  const cited = citedIndexes(text);
  const shown = cited.length
    ? cited.flatMap((n) => sourceFor(sources, n) ?? [])
    : sources.slice(0, 5);
  for (const source of shown) {
    const item = document.createElement('li');
    if (source.index) item.value = source.index;
    const link = isWebLink(source.url) ? source.url : undefined;
    const title = link ? document.createElement('a') : document.createElement('span');
    title.textContent = source.title;
    if (title instanceof HTMLAnchorElement && link) {
      title.href = link;
      title.rel = 'noopener noreferrer';
      title.target = '_blank';
    }
    const excerpt = document.createElement('small');
    excerpt.textContent = source.excerpts[0]?.text ?? '';
    item.append(title, excerpt);
    list.append(item);
  }
};

if (location.pathname === new URL(config.redirectUri).pathname) {
  try {
    await finishLogin(config, deps, new URL(location.href));
  } catch (error) {
    show(error instanceof Error ? error.message : String(error));
  }
  history.replaceState(null, '', '/');
}

const session = currentSession(config, deps);
const platform = genki(config, deps, () => currentSession(config, deps)?.accessToken);

element<HTMLButtonElement>('login').hidden = !!session;
element<HTMLButtonElement>('logout').hidden = !session;
element<HTMLElement>('chat').hidden = !session;
element<HTMLElement>('who').textContent = session?.name ?? '';

element<HTMLButtonElement>('login').addEventListener('click', async () => {
  location.assign(await loginUrl(config, deps));
});
element<HTMLButtonElement>('logout').addEventListener('click', async () => {
  location.assign(await logoutUrl(config, deps));
});

if (session) {
  const picker = element<HTMLSelectElement>('service');
  const answer = element<HTMLDivElement>('answer');
  const sources = element<HTMLOListElement>('sources');
  const threads = element<HTMLUListElement>('threads');
  let conversationId: string | undefined;

  const listThreads = async () => {
    threads.replaceChildren();
    for (const thread of await platform.threads()) {
      const item = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = thread.topic;
      open.addEventListener('click', async () => {
        const messages = await platform.thread(thread.id);
        const last = messages.filter((m) => m.role === 'assistant').at(-1);
        conversationId = thread.id;
        answer.textContent = last?.text ?? '';
        renderSources(sources, last?.text ?? '', last?.sources ?? []);
      });
      item.append(open);
      threads.append(item);
    }
  };

  try {
    for (const service of await platform.services())
      picker.append(new Option(service.title, service.id));
    await listThreads();
  } catch (error) {
    fail(error);
  }

  element<HTMLButtonElement>('new').addEventListener('click', () => {
    conversationId = undefined;
    answer.textContent = '';
    sources.replaceChildren();
  });

  element<HTMLFormElement>('ask').addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = element<HTMLInputElement>('question');
    answer.textContent = '';
    sources.replaceChildren();
    show('');
    try {
      const result = await platform.ask(
        {
          model: picker.value,
          question: question.value,
          ...(conversationId ? { conversationId } : {}),
        },
        (e) => {
          if (e.type === 'text') answer.textContent += e.text;
          if (e.type === 'retract') answer.textContent = '';
        },
      );
      conversationId = result.conversationId ?? conversationId;
      renderSources(sources, result.text, result.sources);
      question.value = '';
      await listThreads();
    } catch (error) {
      fail(error);
    }
  });
}
