/*
  Warnings:

  - You are about to drop the column `languageId` on the `UserAnswer` table. All the data in the column will be lost.
  - You are about to drop the column `languageId` on the `UserCompletedProblem` table. All the data in the column will be lost.
  - You are about to drop the column `languageId` on the `UserProblemSession` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserAnswer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "userId" TEXT NOT NULL,
    "userProblemSessionId" INTEGER NOT NULL,
    "programId" TEXT NOT NULL,
    "problemType" TEXT NOT NULL,
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "step" INTEGER NOT NULL,
    "isPassed" BOOLEAN NOT NULL,
    CONSTRAINT "UserAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserAnswer_userProblemSessionId_fkey" FOREIGN KEY ("userProblemSessionId") REFERENCES "UserProblemSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserAnswer" ("createdAt", "id", "isPassed", "problemType", "programId", "startedAt", "step", "timeSpent", "updatedAt", "userId", "userProblemSessionId") SELECT "createdAt", "id", "isPassed", "problemType", "programId", "startedAt", "step", "timeSpent", "updatedAt", "userId", "userProblemSessionId" FROM "UserAnswer";
DROP TABLE "UserAnswer";
ALTER TABLE "new_UserAnswer" RENAME TO "UserAnswer";
CREATE TABLE "new_UserCompletedProblem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    CONSTRAINT "UserCompletedProblem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserCompletedProblem" ("courseId", "createdAt", "id", "lectureId", "programId", "updatedAt", "userId") SELECT "courseId", "createdAt", "id", "lectureId", "programId", "updatedAt", "userId" FROM "UserCompletedProblem";
DROP TABLE "UserCompletedProblem";
ALTER TABLE "new_UserCompletedProblem" RENAME TO "UserCompletedProblem";
CREATE TABLE "new_UserProblemSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "problemVariablesSeed" TEXT NOT NULL,
    "currentProblemType" TEXT NOT NULL,
    "beforeTraceItemIndex" INTEGER NOT NULL,
    "currentTraceItemIndex" INTEGER NOT NULL,
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "isCompleted" BOOLEAN NOT NULL,
    CONSTRAINT "UserProblemSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserProblemSession" ("beforeTraceItemIndex", "courseId", "createdAt", "currentProblemType", "currentTraceItemIndex", "finishedAt", "id", "isCompleted", "lectureId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId") SELECT "beforeTraceItemIndex", "courseId", "createdAt", "currentProblemType", "currentTraceItemIndex", "finishedAt", "id", "isCompleted", "lectureId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId" FROM "UserProblemSession";
DROP TABLE "UserProblemSession";
ALTER TABLE "new_UserProblemSession" RENAME TO "UserProblemSession";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
