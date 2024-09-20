import type { NextPage } from 'next';

import { prisma } from '../../../../../../infrastructures/prisma';
import { generateProblem } from '../../../../../../problems/generateProblem';
import type { CourseId, LanguageId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../../../../utils/session';

import { ProblemPageOnClient } from './pageOnClient';

type Props = {
  params: { courseId: CourseId; languageId: VisibleLanguageId; programId: ProgramId };
};

const ProblemPage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer();
  const userId = session.superTokensUserId;

  let problemSession = await prisma.problemSession.findFirst({
    where: {
      userId,
      courseId: props.params.courseId,
      programId: props.params.programId,
      languageId: props.params.languageId,
      // eslint-disable-next-line unicorn/no-null
      completedAt: null,
    },
  });

  if (!problemSession) {
    problemSession = await prisma.problemSession.create({
      data: {
        userId,
        courseId: props.params.courseId,
        programId: props.params.programId,
        languageId: props.params.languageId,
        problemVariablesSeed: Date.now().toString(),
        currentProblemType: 'executionResult',
        currentTraceItemIndex: 0,
        previousTraceItemIndex: 0,
      },
    });
  }

  const problem = generateProblem(
    problemSession.programId as ProgramId,
    problemSession.languageId as LanguageId,
    problemSession.problemVariablesSeed
  );

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
