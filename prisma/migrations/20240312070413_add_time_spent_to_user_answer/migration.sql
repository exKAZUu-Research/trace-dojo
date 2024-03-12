-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserAnswer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "problemType" TEXT NOT NULL,
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "step" INTEGER NOT NULL,
    "isPassed" BOOLEAN NOT NULL,
    CONSTRAINT "UserAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserAnswer" ("createdAt", "id", "isPassed", "languageId", "problemType", "programId", "step", "updatedAt", "userId") SELECT "createdAt", "id", "isPassed", "languageId", "problemType", "programId", "step", "updatedAt", "userId" FROM "UserAnswer";
DROP TABLE "UserAnswer";
ALTER TABLE "new_UserAnswer" RENAME TO "UserAnswer";
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
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "isCompleted" BOOLEAN NOT NULL,
    CONSTRAINT "UserProblemSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserProblemSession" ("beforeStep", "courseId", "createdAt", "currentProblemType", "currentStep", "finishedAt", "id", "isCompleted", "languageId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId") SELECT "beforeStep", "courseId", "createdAt", "currentProblemType", "currentStep", "finishedAt", "id", "isCompleted", "languageId", "problemVariablesSeed", "programId", "startedAt", "timeSpent", "updatedAt", "userId" FROM "UserProblemSession";
DROP TABLE "UserProblemSession";
ALTER TABLE "new_UserProblemSession" RENAME TO "UserProblemSession";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
