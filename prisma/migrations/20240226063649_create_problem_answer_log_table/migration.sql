-- CreateTable
CREATE TABLE "ProblemAnswerLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "problemType" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "answeredAt" DATETIME NOT NULL,
    "isPassed" BOOLEAN NOT NULL,
    CONSTRAINT "ProblemAnswerLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
