import type { ScreenProps } from '../../screen';
import { Settings } from '../Settings';

export const SettingsSection = (props: ScreenProps & { id: string }) => (
  <Settings {...props} context={{ kind: 'service', id: props.id }} />
);
