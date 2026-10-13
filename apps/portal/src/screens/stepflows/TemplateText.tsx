import { Chip, Field, Label, Textarea, ValidationMessage } from '@digdir/designsystemet-react';
import { useRef } from 'react';
import type { Option } from './fields';
import { translator, useT, type T } from '../../i18n';
import { refParts, refVisible } from './model';

const nbT = translator('nb');

const piece = /(\{\{\s*[^}]+?\s*\}\})/;
const inner = /^\{\{\s*([^}]+?)\s*\}\}$/;

export const unknownTemplateRef = (text: string, visible: string[], t: T = nbT) => {
  for (const part of text.split(piece)) {
    const expr = inner.exec(part)?.[1];
    if (!expr) continue;
    const missing = refParts(expr).find((r) => !refVisible(r, visible));
    if (missing) return t('stepflows.templateRefMissing', { ref: missing });
  }
  return '';
};

export const TemplateText = ({
  id,
  value,
  visible,
  refs,
  onChange,
}: {
  id: string;
  value: string;
  visible: string[];
  refs: Option[];
  onChange: (text: string) => void;
}) => {
  const t = useT();
  const box = useRef<HTMLTextAreaElement>(null);
  const error = unknownTemplateRef(value, visible, t);
  const insert = (ref: string) => {
    const token = `{{${ref}}}`;
    const el = box.current;
    const at = el && el === document.activeElement ? el.selectionStart : value.length;
    const before = value.slice(0, at);
    const gap = before && !/\s$/.test(before) ? ' ' : '';
    onChange(`${before}${gap}${token}${value.slice(at)}`);
  };
  const labelOf = (ref: string) => refs.find((r) => r.value === ref)?.label ?? ref;
  return (
    <div className="stack-xs">
      <Field data-size="sm">
        <Label htmlFor={id}>{t('stepflows.fixedText')}</Label>
        <Field.Description>
          {t('stepflows.templateHint', { placeholder: '{{steg.felt}}' })}
        </Field.Description>
        <Textarea
          id={id}
          ref={box}
          rows={4}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Field>
      {refs.length ? (
        <div className="template-refs">
          <span className="small">{t('stepflows.insert')}</span>
          {refs.map((r) => (
            <Chip.Button
              key={r.value}
              data-size="sm"
              title={r.label}
              onClick={() => insert(r.value)}
            >
              {r.value}
            </Chip.Button>
          ))}
        </div>
      ) : null}
      {value.includes('{{') ? (
        <div className="template-preview">
          <strong className="small">{t('stepflows.preview')}</strong>
          <p>
            {value.split(piece).map((part, i) => {
              const expr = inner.exec(part)?.[1];
              if (!expr) return part ? <span key={i}>{part}</span> : null;
              const known = refParts(expr).every((r) => refVisible(r, visible));
              return (
                <mark key={i} className={known ? 'template-ref' : 'template-ref unknown'}>
                  {known ? labelOf(expr) : `[${expr}]`}
                </mark>
              );
            })}
          </p>
        </div>
      ) : null}
    </div>
  );
};
