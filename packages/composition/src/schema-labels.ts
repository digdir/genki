import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  inputPerThousand: { label: 'Kroner per 1000 tokens inn' },
  outputPerThousand: { label: 'Kroner per 1000 tokens ut' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  inputPerThousand: { label: 'Kroner per 1,000 input tokens' },
  outputPerThousand: { label: 'Kroner per 1,000 output tokens' },
};

export const priceSchemaLabels: SchemaLabels = { nb, en };
