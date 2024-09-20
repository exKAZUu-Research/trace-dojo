/*
  Warnings:

  - Added the required column `lectureId` to the `UserCompletedProblem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lectureId` to the `UserProblemSession` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserCompletedProblem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    CONSTRAINT "UserCompletedProblem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserCompletedProblem" ("courseId", "createdAt", "id", "languageId", "programId", "updatedAt", "userId") SELECT "courseId", "createdAt", "id", "languageId", "programId", "updatedAt", "userId" FROM "UserCompletedProblem";
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
    "languageId" TEXT NOT NULL,
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
INSERT INTO "new_UserProblemSession" ("beforeTraceItemIndex", "courseId", "createdAt", "currentProblemType", "currentTraceItemIndex", "finishedAt", "id", "isCompleted", "languageId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId") SELECT "beforeTraceItemIndex", "courseId", "createdAt", "currentProblemType", "currentTraceItemIndex", "finishedAt", "id", "isCompleted", "languageId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId" FROM "UserProblemSession";
DROP TABLE "UserProblemSession";
ALTER TABLE "new_UserProblemSession" RENAME TO "UserProblemSession";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
