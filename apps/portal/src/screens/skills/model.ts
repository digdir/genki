import type { SkillSpec } from '../../api/skills';
import type { ProposalSection } from '../../data/skills';
import type { AppliedCard } from './assistant';

export interface EditorCard {
  id: string;
  section: ProposalSection;
  title: string;
  detail: string;
  before?: string;
  after: string;
  afterLabel?: string;
  previous: Pick<SkillSpec, 'description' | 'instructions' | 'examples'>;
  undone: boolean;
}

export interface RejectedEditorCard {
  id: string;
  section: ProposalSection;
  attempted: string;
  reason: string;
  code: string;
}

export interface AssistantNotice {
  section: ProposalSection | 'fix';
  color: 'info' | 'warning' | 'danger';
  text: string;
}

export interface AskState {
  open: boolean;
  applied: AppliedCard[];
  rejected: RejectedEditorCard[];
  notice?: Omit<AssistantNotice, 'section'>;
}
