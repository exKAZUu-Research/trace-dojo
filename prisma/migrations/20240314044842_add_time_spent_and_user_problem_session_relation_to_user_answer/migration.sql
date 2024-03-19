/*
  Warnings:

  - Added the required column `userProblemSessionId` to the `UserAnswer` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserAnswer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "userId" TEXT NOT NULL,
    "userProblemSessionId" INTEGER NOT NULL,
    "programId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "problemType" TEXT NOT NULL,
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "step" INTEGER NOT NULL,
    "isPassed" BOOLEAN NOT NULL,
    CONSTRAINT "UserAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserAnswer_userProblemSessionId_fkey" FOREIGN KEY ("userProblemSessionId") REFERENCES "UserProblemSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserAnswer" ("createdAt", "id", "isPassed", "languageId", "problemType", "programId", "step", "timeSpent", "updatedAt", "userId") SELECT "createdAt", "id", "isPassed", "languageId", "problemType", "programId", "step", "timeSpent", "updatedAt", "userId" FROM "UserAnswer";
DROP TABLE "UserAnswer";
ALTER TABLE "new_UserAnswer" RENAME TO "UserAnswer";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
