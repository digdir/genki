import type { ScreenProps } from '../../screen';
import { BlockStudio } from './BlockStudio';
import { Catalogue } from './Catalogue';
import { ImportWizard } from './ImportWizard';
import { Versions } from './Versions';
import './design.css';

const dotSegment = (segment: string | undefined) => segment === '.' || segment === '..';

/** Block Studio at «Utforming»: the catalogue, one block, its versions, and the import. */
export const Design = (props: ScreenProps) => {
  const [, first, second, third] = props.route.segments;
  if (first === 'import' || first === 'new') return <ImportWizard {...props} />;
  if (first && second && !dotSegment(first) && !dotSegment(second)) {
    const key = `${first}/${second}`;
    return third === 'versions' ? (
      <Versions key={key} {...props} publisher={first} id={second} />
    ) : (
      <BlockStudio key={key} {...props} publisher={first} id={second} />
    );
  }
  return <Catalogue {...props} />;
};
