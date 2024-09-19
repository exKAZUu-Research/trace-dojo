-- DropIndex
DROP INDEX "User_displayName_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "UserAnswer";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "UserCompletedProblem";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "UserProblemSession";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "ProblemSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "problemVariablesSeed" TEXT NOT NULL,
    "currentProblemType" TEXT NOT NULL,
    "currentTraceItemIndex" INTEGER NOT NULL,
    "previousTraceItemIndex" INTEGER NOT NULL,
    "elapsedMilliseconds" INTEGER NOT NULL DEFAULT 0,
    "completedAt" DATETIME,
    CONSTRAINT "ProblemSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProblemSessionAnswer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" INTEGER NOT NULL,
    "problemType" TEXT NOT NULL,
    "traceItemIndex" INTEGER NOT NULL,
    "elapsedMilliseconds" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    CONSTRAINT "ProblemSessionAnswer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ProblemSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProblemSession_userId_courseId_programId_languageId_completedAt_idx" ON "ProblemSession"("userId", "courseId", "programId", "languageId", "completedAt");
