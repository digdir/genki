import { Alert, Paragraph } from '@digdir/designsystemet-react';
import { ApiError } from '../../api';

/** What the API refused, with each field's message by its path. */
export const Problems = ({ error }: { error: unknown }) => {
  const problem = error instanceof ApiError ? error.problem : undefined;
  const title = problem?.title ?? (error instanceof Error ? error.message : String(error));
  return (
    <Alert data-color="danger" data-size="sm">
      <Paragraph data-size="sm">{problem?.detail ?? title}</Paragraph>
      {problem?.errors?.length ? <FieldErrors errors={problem.errors} /> : null}
    </Alert>
  );
};

export const FieldErrors = ({ errors }: { errors: { path: string; message: string }[] }) => (
  <ul className="design-errors">
    {errors.map((e) => (
      <li key={`${e.path}:${e.message}`}>
        <code>{e.path}</code> {e.message}
      </li>
    ))}
  </ul>
);
