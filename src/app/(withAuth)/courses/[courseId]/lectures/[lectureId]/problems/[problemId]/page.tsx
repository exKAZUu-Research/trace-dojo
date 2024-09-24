import type { NextPage } from 'next';

import { DEFAULT_LANGUAGE_ID } from '../../../../../../../../constants';
import { prisma } from '../../../../../../../../infrastructures/prisma';
import { generateProblem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../../../../../../utils/session';

import { ProblemPageOnClient } from './pageOnClient';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
};

const ProblemPage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer();

  let problemSession = await prisma.problemSession.findFirst({
    where: {
      userId: session.superTokensUserId,
      courseId: props.params.courseId,
      lectureId: props.params.lectureId,
      problemId: props.params.problemId,
      // eslint-disable-next-line unicorn/no-null
      completedAt: null,
    },
  });

  if (!problemSession) {
    problemSession = await prisma.problemSession.create({
      data: {
        userId: session.superTokensUserId,
        courseId: props.params.courseId,
        lectureId: props.params.lectureId,
        problemId: props.params.problemId,
        problemVariablesSeed: Date.now().toString(),
        currentProblemType: 'executionResult',
        currentTraceItemIndex: 0,
        previousTraceItemIndex: 0,
      },
    });
  }

  const problem = generateProblem(
    problemSession.problemId as ProblemId,
    DEFAULT_LANGUAGE_ID,
    problemSession.problemVariablesSeed
  );
  if (!problem) throw new Error('Failed to generate problem.');

  return (
    <ProblemPageOnClient
      initialProblemSession={problemSession}
      params={props.params}
      problem={problem}
      userId={session.superTokensUserId}
    />
  );
};

export default ProblemPage;
