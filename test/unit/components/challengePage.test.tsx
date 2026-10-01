// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

vi.mock('@/app/utils/withAuth', () => ({
  withAuthorizationOnServer:
    (Page: React.FC<Record<string, unknown>>) =>
    async ({ params, searchParams }: { params: Promise<unknown>; searchParams: Promise<unknown> }) =>
      Page({ params: await params, searchParams: await searchParams }),
}));
vi.mock('@/problems/problemData', () => ({ courseIdToLectureIds: { test: ['lecture-1'] } }));
vi.mock('../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/pageOnClient', () => ({
  ChallengePageOnClient: ({ initialFormat }: { initialFormat?: string }) => (
    <output data-testid="initial-format">{initialFormat ?? 'undefined'}</output>
  ),
}));

import ChallengePage from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/page';

const renderChallengePage = ChallengePage as unknown as (props: {
  params: Promise<{ courseId: string; lectureId: string }>;
  searchParams: Promise<{ format?: string | string[] }>;
}) => Promise<React.ReactNode>;

test.each([
  ['regular', 'regular'],
  ['fillInBlank', 'fillInBlank'],
  [undefined, 'undefined'],
  ['unknown', 'undefined'],
  [['regular', 'fillInBlank'], 'undefined'],
])('passes a validated resolved format from the authorized page boundary: %j', async (format, expected) => {
  const page = await renderChallengePage({
    params: Promise.resolve({ courseId: 'test', lectureId: 'lecture-1' }),
    searchParams: Promise.resolve(format === undefined ? {} : { format }),
  });
  render(page);
  expect(screen.getByTestId('initial-format')).toHaveTextContent(expected);
});
