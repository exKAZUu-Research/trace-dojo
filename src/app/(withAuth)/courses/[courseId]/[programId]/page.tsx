import type { NextPage } from 'next';

import { generateProblem } from '../../../../../problems/generateProblem';
import type { CourseId, LanguageId, ProgramId } from '../../../../../problems/problemData';
import { getSuspendedUserProblemSession } from '../../../../../utils/fetch';
import { getNonNullableSessionOnServer } from '../../../../../utils/session';
import { upsertUserProblemSession } from '../../../../../utils/upsertUserProblemSession';

import { BaseProblem } from './BaseProblem';

const ProblemPage: NextPage<{
  params: { courseId: CourseId; programId: ProgramId };
}> = async ({ params }) => {
  const session = await getNonNullableSessionOnServer();
  const userId = session.superTokensUserId;
  const courseId = params.courseId;
  const programId = params.programId;

  let userProblemSession = await getSuspendedUserProblemSession(userId, courseId, programId, 'java');
  if (!userProblemSession) {
    const problemVariableSeed = Date.now().toString();
    const problemType = 'executionResult';
    const startedAt = new Date();

    userProblemSession = await upsertUserProblemSession(
      // createするためにidに0を指定
      0,
      userId,
      courseId,
      programId,
      'java',
      problemVariableSeed,
      problemType,
      0,
      0,
      undefined,
      startedAt,
      undefined,
      false
    );
  }

  const problem = userProblemSession
    ? generateProblem(
        userProblemSession.programId as ProgramId,
        userProblemSession.languageId as LanguageId,
        userProblemSession.problemVariablesSeed
      )
    : undefined;

  return (
    userProblemSession &&
    problem && (
      <BaseProblem
        courseId={params.courseId}
        languageId="java"
        problem={problem}
        programId={params.programId}
        userId={session.superTokensUserId}
        userProblemSession={userProblemSession}
      />
    )
  );
};

export default ProblemPage;
