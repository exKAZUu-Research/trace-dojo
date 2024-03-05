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
    "currentProblemType" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL,
    "timeSpent" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "isCompleted" BOOLEAN NOT NULL,
    CONSTRAINT "UserProblemSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserProblemSession" ("courseId", "createdAt", "currentProblemType", "currentStep", "finishedAt", "id", "isCompleted", "languageId", "programId", "startedAt", "timeSpent", "updatedAt", "userId") SELECT "courseId", "createdAt", "currentProblemType", "currentStep", "finishedAt", "id", "isCompleted", "languageId", "programId", "startedAt", "timeSpent", "updatedAt", "userId" FROM "UserProblemSession";
DROP TABLE "UserProblemSession";
ALTER TABLE "new_UserProblemSession" RENAME TO "UserProblemSession";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
