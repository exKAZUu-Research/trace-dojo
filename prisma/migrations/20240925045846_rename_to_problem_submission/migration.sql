-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ProblemSessionAnswer";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "ProblemSubmission" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" INTEGER NOT NULL,
    "problemType" TEXT NOT NULL,
    "traceItemIndex" INTEGER NOT NULL,
    "elapsedMilliseconds" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    CONSTRAINT "ProblemSubmission_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ProblemSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
