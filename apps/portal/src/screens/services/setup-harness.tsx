import { useState, type ComponentProps } from 'react';
import { applySpec, type ServiceDefinition } from '../../data/service-definition';
import { renameService } from '../../data/service-form';
import { SetupTab, type SectionId } from './SetupTab';

type SetupProps = ComponentProps<typeof SetupTab>;

export const SetupHarness = ({
  initial,
  sections,
  published = false,
  onChange,
  ...rest
}: Partial<Omit<SetupProps, 'definition' | 'patch' | 'onRename'>> & {
  initial: ServiceDefinition;
  sections: SectionId[];
  published?: boolean;
  onChange?: (d: ServiceDefinition) => void;
}) => {
  const [definition, setDefinition] = useState(initial);
  onChange?.(definition);
  return (
    <SetupTab
      serviceId="ny"
      open={Object.fromEntries(sections.map((id) => [id, true]))}
      onToggle={() => undefined}
      highlight=""
      fromAi={{}}
      prohibited={{}}
      onProhibited={() => undefined}
      riskConfirmed={false}
      onConfirmRisk={() => undefined}
      narrow={false}
      {...rest}
      sections={sections}
      definition={definition}
      patch={(edit) => setDefinition((d) => applySpec(d, edit))}
      onRename={(name) => setDefinition((d) => renameService(d, name, published))}
    />
  );
};
