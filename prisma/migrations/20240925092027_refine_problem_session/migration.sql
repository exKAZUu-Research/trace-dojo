-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ProblemSession";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "ProblemSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "problemVariablesSeed" TEXT NOT NULL,
    "problemType" TEXT NOT NULL,
    "traceItemIndex" INTEGER NOT NULL,
    "elapsedMilliseconds" INTEGER NOT NULL DEFAULT 0,
    "completedAt" DATETIME,
    CONSTRAINT "ProblemSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ProblemSession_userId_courseId_lectureId_problemId_completedAt_idx" ON "ProblemSession"("userId", "courseId", "lectureId", "problemId", "completedAt");
