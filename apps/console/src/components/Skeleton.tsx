import { Skeleton, Table } from '@digdir/designsystemet-react';

export type SkeletonShape = 'list' | 'detail' | 'table' | 'form' | 'cards';

const listWidths: [string, string][] = [
  ['46%', '78%'],
  ['38%', '70%'],
  ['52%', '62%'],
  ['34%', '74%'],
  ['44%', '66%'],
];

const tableWidths = ['70%', '55%', '85%', '60%'];

const Bar = ({ width, height }: { width: string | number; height: number }) => (
  <Skeleton variant="rectangle" width={width} height={height} className="skeleton-bar" />
);

const ListSkeleton = ({ rows }: { rows: number }) => (
  <div className="skeleton-list">
    {Array.from({ length: rows }, (_, row) => {
      const [title, line] = listWidths[row % listWidths.length] ?? ['40%', '70%'];
      return (
        <div key={row} className="skeleton-list-row">
          <div className="skeleton-lines">
            <Bar width={title} height={16} />
            <Bar width={line} height={12} />
          </div>
          <Bar width={72} height={22} />
        </div>
      );
    })}
  </div>
);

const DetailSkeleton = () => (
  <div className="skeleton-detail">
    <div className="skeleton-lines skeleton-detail-main">
      <Bar width="40%" height={20} />
      <Bar width="100%" height={12} />
      <Bar width="94%" height={12} />
      <Bar width="70%" height={12} />
      <span className="skeleton-gap" />
      <Bar width="36%" height={20} />
      <Bar width="100%" height={12} />
      <Bar width="82%" height={12} />
    </div>
    <div className="skeleton-detail-aside">
      {[0, 1, 2].map((row) => (
        <div key={row} className="skeleton-pair">
          <Bar width={60} height={12} />
          <Bar width="100%" height={12} />
        </div>
      ))}
    </div>
  </div>
);

const TableSkeleton = ({ rows, columns }: { rows: number; columns: number | string[] }) => {
  const heads = typeof columns === 'number' ? Array.from({ length: columns }, () => '') : columns;
  return (
    <Table className="skeleton-table">
      <Table.Head>
        <Table.Row>
          {heads.map((head, column) => (
            <Table.HeaderCell key={column}>
              {head || <Bar width="50%" height={12} />}
            </Table.HeaderCell>
          ))}
        </Table.Row>
      </Table.Head>
      <Table.Body>
        {Array.from({ length: rows }, (_, row) => (
          <Table.Row key={row}>
            {heads.map((_, column) => (
              <Table.Cell key={column}>
                <Bar
                  width={tableWidths[(row + column) % tableWidths.length] ?? '60%'}
                  height={12}
                />
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

const CardsSkeleton = ({ rows }: { rows: number }) => (
  <div className="skeleton-cards">
    {Array.from({ length: rows }, (_, card) => (
      <div key={card} className="skeleton-card skeleton-lines">
        <Bar width={listWidths[card % listWidths.length]?.[0] ?? '40%'} height={16} />
        <Bar width="60%" height={12} />
        <Bar width="80%" height={22} />
        <span className="skeleton-gap" />
        <Bar width="100%" height={12} />
        <Bar width="100%" height={12} />
        <Bar width="100%" height={12} />
      </div>
    ))}
  </div>
);

const FormSkeleton = ({ rows }: { rows: number }) => (
  <div className="skeleton-form">
    {Array.from({ length: rows }, (_, row) => (
      <div key={row} className="skeleton-lines">
        <Bar width={row % 2 ? '24%' : '32%'} height={14} />
        <Bar width="100%" height={40} />
      </div>
    ))}
    <Bar width={120} height={40} />
  </div>
);

export const ShapeSkeleton = ({
  shape,
  rows,
  columns = 4,
}: {
  shape: SkeletonShape;
  rows?: number;
  columns?: number | string[];
}) => (
  <div className="skeleton" aria-hidden="true">
    {shape === 'list' ? (
      <ListSkeleton rows={rows ?? 5} />
    ) : shape === 'table' ? (
      <TableSkeleton rows={rows ?? 4} columns={columns} />
    ) : shape === 'form' ? (
      <FormSkeleton rows={rows ?? 3} />
    ) : shape === 'cards' ? (
      <CardsSkeleton rows={rows ?? 6} />
    ) : (
      <DetailSkeleton />
    )}
  </div>
);
