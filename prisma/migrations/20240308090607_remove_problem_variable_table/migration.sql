/*
  Warnings:

  - You are about to drop the `ProblemVariable` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `problemVariablesSeed` to the `UserProblemSession` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "ProblemVariable_userProblemSessionId_position_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ProblemVariable";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserProblemSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "problemVariablesSeed" TEXT NOT NULL,
    "currentProblemType" TEXT NOT NULL,
    "beforeStep" INTEGER NOT NULL,
    "currentStep" INTEGER NOT NULL,
    "timeSpent" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "isCompleted" BOOLEAN NOT NULL,
    CONSTRAINT "UserProblemSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserProblemSession" ("beforeStep", "courseId", "createdAt", "currentProblemType", "currentStep", "finishedAt", "id", "isCompleted", "languageId", "programId", "startedAt", "timeSpent", "updatedAt", "userId") SELECT "beforeStep", "courseId", "createdAt", "currentProblemType", "currentStep", "finishedAt", "id", "isCompleted", "languageId", "programId", "startedAt", "timeSpent", "updatedAt", "userId" FROM "UserProblemSession";
DROP TABLE "UserProblemSession";
ALTER TABLE "new_UserProblemSession" RENAME TO "UserProblemSession";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
