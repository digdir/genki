import { useEffect } from 'react';
import type { Route } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { Loading } from '../states';
import { skillHref } from './skills/SkillBlockPage';

export const skillsRedirect = (route: Route) => {
  const id = route.query.get('id');
  return id
    ? skillHref(id, 'setup', route.query.get('owner') ?? undefined)
    : '#/building-blocks/in-use?type=skill';
};

export const Skills = ({ route }: ScreenProps) => {
  const t = useT();
  const target = skillsRedirect(route);
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return <Loading label={t('skills.editorLoading')} shape="detail" />;
};
