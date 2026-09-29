// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

const count = vi.hoisted(() => ({ value: 0 }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'test', lectureId: 'test', problemId: 'test3' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('../../../src/contexts/AuthContext', () => ({ useAuthContextSelector: () => false }));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    countIncorrectSubmissions: {
      useQuery: () => ({ refetch: async () => ({ data: count.value++ }) }),
    },
  },
}));

import { ProblemBody } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/ProblmBody';
import { instantiateProblem } from '../../../src/problems/instantiateProblem';

test('keeps the normal three-wrong automatic fallback through the real editor', async () => {
  count.value = 0;
  const problem = instantiateProblem('test3', 'java', 'normal-component');
  if (!problem) throw new Error('test3 must instantiate');
  const createSubmission = vi.fn(async () => {});
  const updateSession = vi.fn(async () => {});
  const user = userEvent.setup();
  render(
    <ChakraProvider>
      <ProblemBody
        problem={problem}
        problemSession={
          {
            id: 1,
            problemType: 'executionResult',
            traceItemIndex: 0,
          } as never
        }
        createSubmissionUpdatingProblemSession={createSubmission}
        updateProblemSession={updateSession}
      />
    </ChakraProvider>
  );
  for (const input of screen.getAllByRole('textbox')) await user.type(input, '999');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await user.click(screen.getByRole('button', { name: /提出/ }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('不正解');
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
  }
  expect(createSubmission).toHaveBeenCalledTimes(3);
  expect(createSubmission).toHaveBeenLastCalledWith(false, false);
  expect(updateSession).toHaveBeenCalledWith('step', 1);
});

test.each([
  { traceItemIndex: 1, typedValue: '1', isCompleted: false, nextIndex: 2 },
  { traceItemIndex: 5, typedValue: '4', isCompleted: true, nextIndex: undefined },
])(
  'keeps normal correct step $traceItemIndex advance/completion through the real editor',
  async ({ traceItemIndex, typedValue, isCompleted, nextIndex }) => {
    const problem = instantiateProblem('test3', 'java', 'normal-component');
    if (!problem) throw new Error('test3 must instantiate');
    const createSubmission = vi.fn(async () => {});
    const updateSession = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <ChakraProvider>
        <ProblemBody
          problem={problem}
          problemSession={{ id: 2, problemType: 'step', traceItemIndex } as never}
          createSubmissionUpdatingProblemSession={createSubmission}
          updateProblemSession={updateSession}
        />
      </ChakraProvider>
    );
    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs.at(-1)!, typedValue);
    await user.click(screen.getByRole('button', { name: /提出/ }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('正解');
    expect(createSubmission).toHaveBeenCalledWith(true, isCompleted);
    if (nextIndex === undefined) expect(updateSession).not.toHaveBeenCalled();
    else expect(updateSession).toHaveBeenCalledWith('step', nextIndex);
  }
);
