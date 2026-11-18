import type { ScreenProps } from '../screen';
import { LiveDatasets } from './datasets/LiveDatasets';
import './datasets.css';
import './shared.css';

export const Datasets = (props: ScreenProps) => <LiveDatasets {...props} />;
