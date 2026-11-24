import type { TemplateIcon } from '@genai/contracts/block-template';
import type { ComponentType, SVGProps } from 'react';
import {
  BookIcon,
  BookmarkIcon,
  Buildings3Icon,
  CalendarIcon,
  ChatIcon,
  CheckmarkCircleIcon,
  ClockIcon,
  ExclamationmarkTriangleIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  FileTextIcon,
  InformationSquareIcon,
  LinkIcon,
  PersonIcon,
  QuestionmarkCircleIcon,
  RobotIcon,
  StarIcon,
  TagIcon,
  XMarkOctagonIcon,
} from '@navikt/aksel-icons';

/** The Aksel icons a declarative block may draw, by the name its template gives. */
export const templateIconComponents: Record<
  TemplateIcon,
  ComponentType<SVGProps<SVGSVGElement> & { title?: string }>
> = {
  'information-square': InformationSquareIcon,
  'exclamationmark-triangle': ExclamationmarkTriangleIcon,
  'checkmark-circle': CheckmarkCircleIcon,
  'x-mark-octagon': XMarkOctagonIcon,
  'questionmark-circle': QuestionmarkCircleIcon,
  'file-text': FileTextIcon,
  'file-search': FileSearchIcon,
  book: BookIcon,
  link: LinkIcon,
  'external-link': ExternalLinkIcon,
  chat: ChatIcon,
  robot: RobotIcon,
  calendar: CalendarIcon,
  clock: ClockIcon,
  bookmark: BookmarkIcon,
  star: StarIcon,
  tag: TagIcon,
  person: PersonIcon,
  buildings3: Buildings3Icon,
};
