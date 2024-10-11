import type { NextPage } from 'next';

import { logger } from '../../../../../../../../infrastructures/pino';
import { prisma } from '../../../../../../../../infrastructures/prisma';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../../../../../../utils/session';

import { ProblemPageOnClient } from './pageOnClient';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
};

const ProblemPage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer();

  let incompleteProblemSession = await prisma.problemSession.findFirst({
    where: {
      userId: session.superTokensUserId,
      courseId: props.params.courseId,
      lectureId: props.params.lectureId,
      problemId: props.params.problemId,
      // eslint-disable-next-line unicorn/no-null
      completedAt: null,
    },
  });
  if (!incompleteProblemSession) {
    incompleteProblemSession = await prisma.problemSession.create({
      data: {
        userId: session.superTokensUserId,
        courseId: props.params.courseId,
        lectureId: props.params.lectureId,
        problemId: props.params.problemId,
        problemVariablesSeed: Date.now().toString(),
        problemType: 'executionResult',
        traceItemIndex: 0,
      },
    });
  }
  logger.debug('incompleteProblemSession: %o', incompleteProblemSession);

  return (
    <ProblemPageOnClient
      initialProblemSession={incompleteProblemSession}
      params={props.params}
      userId={session.superTokensUserId}
    />
  );
};

export default ProblemPage;
