import type { ScreenProps } from '../../screen';
import { DesignEditor } from './DesignEditor';
import { DesignList } from './DesignList';
import { NewDesign } from './NewDesign';
import './design.css';

const dotSegment = (segment: string | undefined) => segment === '.' || segment === '..';

/** The organisation's «Utforming»: its designelementer, genki's and those shared with everyone. */
export const Design = (props: ScreenProps) => {
  const [, first, second] = props.route.segments;
  if (first === 'new') return <NewDesign {...props} />;
  if (first && second && !dotSegment(first) && !dotSegment(second))
    return <DesignEditor key={`${first}/${second}`} {...props} publisher={first} id={second} />;
  return <DesignList {...props} />;
};
