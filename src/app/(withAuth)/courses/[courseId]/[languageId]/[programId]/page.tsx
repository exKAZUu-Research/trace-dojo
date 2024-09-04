import type { UserProblemSession } from '@prisma/client';
import type { NextPage } from 'next';

import { generateProblem, type Problem } from '../../../../../../problems/generateProblem';
import type { CourseId, LanguageId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../../../../utils/session';
import { getSuspendedUserProblemSession, upsertUserProblemSession } from '../../../../../lib/actions';

import { BaseProblem } from './BaseProblem';

const ProblemPage: NextPage<{
  params: { courseId: CourseId; languageId: VisibleLanguageId; programId: ProgramId };
}> = async ({ params }) => {
  const session = await getNonNullableSessionOnServer();
  const userId = session.superTokensUserId;
  const courseId = params.courseId;
  const languageId = params.languageId;
  const programId = params.programId;

  const suspendedSession: UserProblemSession | undefined = await getSuspendedUserProblemSession(
    userId,
    courseId,
    programId,
    languageId
  );

  let userProblemSession = suspendedSession;

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
      languageId,
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

  const problem: Problem | undefined = userProblemSession
    ? generateProblem(
        userProblemSession.programId as ProgramId,
        userProblemSession.languageId as LanguageId,
        userProblemSession.problemVariablesSeed
      )
    : undefined;

  return userProblemSession && problem ? (
    <BaseProblem
      courseId={params.courseId}
      languageId={languageId}
      problem={problem}
      programId={params.programId}
      userId={session.superTokensUserId}
      userProblemSession={userProblemSession}
    />
  ) : (
    <></>
  );
};

export default ProblemPage;
