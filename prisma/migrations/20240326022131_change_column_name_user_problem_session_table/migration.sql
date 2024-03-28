/*
  Warnings:

  - You are about to drop the column `beforeStep` on the `UserProblemSession` table. All the data in the column will be lost.
  - You are about to drop the column `currentStep` on the `UserProblemSession` table. All the data in the column will be lost.
  - Added the required column `beforeTraceItemIndex` to the `UserProblemSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `currentTraceItemIndex` to the `UserProblemSession` table without a default value. This is not possible if the table is not empty.

*/
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
    "beforeTraceItemIndex" INTEGER NOT NULL,
    "currentTraceItemIndex" INTEGER NOT NULL,
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "isCompleted" BOOLEAN NOT NULL,
    CONSTRAINT "UserProblemSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserProblemSession" ("courseId", "createdAt", "currentProblemType", "finishedAt", "id", "isCompleted", "languageId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId") SELECT "courseId", "createdAt", "currentProblemType", "finishedAt", "id", "isCompleted", "languageId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId" FROM "UserProblemSession";
DROP TABLE "UserProblemSession";
ALTER TABLE "new_UserProblemSession" RENAME TO "UserProblemSession";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
