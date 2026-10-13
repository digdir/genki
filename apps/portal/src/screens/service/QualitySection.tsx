import type { ScreenProps } from '../../screen';
import { Quality } from '../Quality';

export const QualitySection = (props: ScreenProps & { id: string }) => <Quality {...props} />;
