export type ManagementTokenSource = (scope: string) => Promise<{ token: string } | null>;

export const recorderJobPattern =
  /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.App\/jobs\/[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export const jobsApiVersion = '2024-03-01';

const armScope = 'https://management.azure.com/.default';

export const recorderJobFrom = (
  env: NodeJS.ProcessEnv,
  tokens: ManagementTokenSource,
  fetchFn: typeof fetch = fetch,
): ((recording: string) => Promise<void>) | undefined => {
  if (env.GENAI_DEMO_RECORDER !== 'job') return undefined;
  const job = env.GENAI_DEMO_RECORDER_JOB?.trim() ?? '';
  if (!recorderJobPattern.test(job)) return undefined;
  return async () => {
    const access = await tokens(armScope);
    if (!access) throw new Error('no Azure token to start the recorder job');
    const res = await fetchFn(
      `https://management.azure.com${job}/start?api-version=${jobsApiVersion}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${access.token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`the recorder job did not start: ${res.status}`);
  };
};
