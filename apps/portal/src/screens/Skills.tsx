import { Alert } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ScreenProps } from '../screen';
import { SkillEditor } from './skills/SkillEditor';
import { SkillList } from './skills/SkillList';
import './skills.css';

export const Skills = (props: ScreenProps) => {
  const id = props.route.query.get('id');
  const owner = props.route.query.get('owner') ?? undefined;
  const [flash, setFlash] = useState<{
    text: string;
    at: string | null;
    color: 'success' | 'danger';
  }>();
  const notify = (text: string, at: string | null = id, color: 'success' | 'danger' = 'success') =>
    setFlash({ text, at, color });
  const shown = flash && flash.at === id ? flash : undefined;
  return (
    <div className="stack skills">
      <div aria-live="polite">
        {shown ? (
          <Alert
            data-color={shown.color}
            data-size="sm"
            role={shown.color === 'danger' ? 'alert' : undefined}
          >
            {shown.text}
          </Alert>
        ) : null}
      </div>
      {id ? (
        <SkillEditor
          key={`${owner ?? ''}/${id}`}
          {...props}
          id={id}
          owner={owner}
          notify={notify}
        />
      ) : (
        <SkillList {...props} notify={notify} />
      )}
    </div>
  );
};
