// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

const infrastructure = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  useParams: () => ({
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemId: 'test3',
  }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('react-idle-timer', () => ({ useIdleTimer: vi.fn() }));
vi.mock('../../../src/contexts/AuthContext', () => ({
  useAuthContextSelector: (selector: (context: { isAdmin: boolean }) => unknown) =>
    selector({ isAdmin: infrastructure.isAdmin }),
}));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    countIncorrectSubmissions: { useQuery: () => ({ refetch: vi.fn() }) },
    createProblemSubmission: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    gradeFillInBlankAnswers: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    updateProblemSession: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }) },
  },
}));

import { ProblemPageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/pageOnClient';

beforeEach(() => {
  infrastructure.isAdmin = false;
});

test.each([
  ['executionResult', '諦めてステップ実行モードに移る'],
  ['step', 'ステップ実行モードで最初からやり直す'],
] as const)('keeps the normal header and %s control', async (problemType, controlName) => {
  renderPage(problemType);
  expect(screen.getByRole('link', { name: '動作確認用' })).toBeVisible();
  expect(screen.getByRole('link', { name: '第1回' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'ステップ実行のテスト用問題(3)' })).toBeVisible();
  const control = screen.getByRole('button', { name: controlName });
  expect(control).toBeVisible();
  if (problemType === 'executionResult') {
    await userEvent.setup().hover(control);
    expect(await screen.findByText('減点になりますが、確実に問題を解けます。')).toBeInTheDocument();
  }
});

test('hides regular controls for fill-in-blank and retains the admin next-step action', () => {
  const rendered = renderPage('fillInBlank');
  expect(screen.queryByRole('button', { name: /ステップ実行モード/ })).not.toBeInTheDocument();

  rendered.unmount();
  infrastructure.isAdmin = true;
  renderPage('step');
  expect(screen.getByRole('button', { name: '次のステップに進む（管理者のみ）' })).toBeVisible();
});

const renderPage = (problemType: 'executionResult' | 'step' | 'fillInBlank'): ReturnType<typeof render> =>
  render(
    <ChakraProvider>
      <ProblemPageOnClient
        initialProblemSession={
          {
            id: 10,
            problemType,
            problemVariablesSeed: 'normal-component',
            traceItemIndex: problemType === 'step' ? 1 : 0,
          } as never
        }
        userId="user-1"
      />
    </ChakraProvider>
  );
