import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { definitionKindParams } from './definition-kinds';
import { useT } from './i18n';
import { formatOrgNumber } from './screens/Tenants';
import type { Tenant, TenantDefinition } from './types';

export interface SearchSource {
  tenants: (signal?: AbortSignal) => Promise<Tenant[]>;
  services: (tenant: string, signal?: AbortSignal) => Promise<TenantDefinition[]>;
}

interface Found {
  tenants: Tenant[];
  services: (TenantDefinition & { tenant: Tenant })[];
  complete: boolean;
  failed?: boolean;
}

interface Option {
  id: string;
  href: string;
  label: string;
  meta?: string;
}

const maxPerGroup = 5;

const useIndex = (source: SearchSource, open: boolean) => {
  const [found, setFound] = useState<Found>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      let tenants: Tenant[];
      try {
        tenants = await source.tenants(signal);
      } catch {
        if (!signal.aborted)
          setFound(
            (before) => before ?? { tenants: [], services: [], complete: true, failed: true },
          );
        return;
      }
      if (signal.aborted) return;
      setFound((before) => ({ tenants, services: before?.services ?? [], complete: false }));
      const lists = await Promise.all(
        tenants
          .filter((tenant) => tenant.services > 0)
          .map((tenant) =>
            source.services(tenant.orgNumber, signal).then(
              (definitions) =>
                definitions
                  .filter((d) => d.kind === 'Service' && d.state !== 'archived')
                  .map((d) => ({ ...d, tenant })),
              () => [],
            ),
          ),
      );
      if (!signal.aborted) setFound({ tenants, services: lists.flat(), complete: true });
    })();
    return () => controller.abort();
  }, [open, source]);
  return found;
};

const matches = (query: string, ...texts: string[]) => {
  const needle = query.trim().toLowerCase();
  const digits = needle.replace(/\s/g, '');
  return texts.some((text) => {
    const hay = text.toLowerCase();
    return hay.includes(needle) || (/^\d+$/.test(digits) && hay.includes(digits));
  });
};

export const SearchDialog = ({
  source,
  open,
  onClose,
}: {
  source: SearchSource;
  open: boolean;
  onClose: () => void;
}) => {
  const t = useT();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const found = useIndex(source, open);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      setQuery('');
      setActive(0);
      input.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const groups = useMemo(() => {
    if (!found || !query.trim()) return [];
    const tenants = found.tenants
      .filter((x) => matches(query, x.name, x.orgNumber))
      .slice(0, maxPerGroup);
    const services = found.services
      .filter((s) => matches(query, s.name, s.id))
      .slice(0, maxPerGroup);
    const option = (n: number, rest: Omit<Option, 'id'>): Option => ({
      id: `${id}-${n}`,
      ...rest,
    });
    let n = 0;
    const tenantOptions = tenants.map((x) =>
      option(n++, {
        href: `#/tenants/services?tenant=${encodeURIComponent(x.orgNumber)}`,
        label: x.name,
        meta:
          x.status === 'onboarding'
            ? t('frame.searchOnboarding', { orgNr: formatOrgNumber(x.orgNumber) })
            : x.quotaUsedPercent === undefined
              ? formatOrgNumber(x.orgNumber)
              : t('frame.searchQuota', {
                  orgNr: formatOrgNumber(x.orgNumber),
                  percent: Math.round(x.quotaUsedPercent),
                }),
      }),
    );
    const serviceOptions = services.map((s) =>
      option(n++, {
        href: `#/tenants/services?${new URLSearchParams({ tenant: s.tenant.orgNumber, kind: definitionKindParams[s.kind], id: s.id }).toString()}`,
        label: s.name,
        meta: s.tenant.name,
      }),
    );
    const first = tenants[0];
    const actionOptions = first
      ? [
          option(n++, {
            href: `#/support-access?tenant=${encodeURIComponent(first.orgNumber)}&tab=settings`,
            label: t('frame.searchActionLimits', { name: first.name }),
          }),
        ]
      : [];
    return [
      { key: 'tenants', title: t('frame.searchGroupTenants'), options: tenantOptions },
      { key: 'services', title: t('frame.searchGroupServices'), options: serviceOptions },
      { key: 'actions', title: t('frame.searchGroupActions'), options: actionOptions },
    ].filter((g) => g.options.length > 0);
  }, [found, query, id, t]);

  const options = groups.flatMap((g) => g.options);
  const current = options[Math.min(active, options.length - 1)];

  const go = (option: Option | undefined) => {
    if (!option) return;
    onClose();
    window.location.hash = option.href;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!options.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (Math.min(a, options.length - 1) + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(current);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const listId = `${id}-list`;
  const status = !query.trim()
    ? undefined
    : options.length > 0
      ? undefined
      : found?.failed
        ? t('frame.searchFailed')
        : found?.complete
          ? t('frame.searchNoHits', { query: query.trim() })
          : t('frame.searchLoading');

  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-label={t('frame.searchDialog')}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <div className="search-panel">
          <div className="search-box">
            <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
              <path
                d="M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM12 12l4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <input
              ref={input}
              type="search"
              role="combobox"
              aria-label={t('frame.searchField')}
              aria-expanded={options.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={current?.id}
              autoComplete="off"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <kbd>{t('frame.keyEscape')}</kbd>
          </div>
          <div className="search-results">
            <div id={listId} role="listbox" aria-label={t('frame.searchDialog')}>
              {groups.map((group) => (
                <div key={group.key} role="group" aria-labelledby={`${id}-${group.key}`}>
                  <div className="search-group" id={`${id}-${group.key}`} role="presentation">
                    {group.title}
                  </div>
                  {group.options.map((option) => (
                    <div
                      key={option.id}
                      id={option.id}
                      role="option"
                      aria-selected={option === current}
                      className={option === current ? 'search-option active' : 'search-option'}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => go(option)}
                    >
                      <span className={option === current ? 'strong' : undefined}>
                        {option.label}
                      </span>
                      {option.meta ? <span className="search-meta">{option.meta}</span> : null}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {status ? (
              <p className="search-status" role="status">
                {status}
              </p>
            ) : null}
          </div>
          <div className="search-hints" aria-hidden="true">
            <span>{t('frame.searchHintMove')}</span>
            <span>{t('frame.searchHintOpen')}</span>
            <span>{t('frame.searchHintClose')}</span>
          </div>
        </div>
      ) : null}
    </dialog>
  );
};
