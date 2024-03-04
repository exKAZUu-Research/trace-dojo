-- CreateTable
CREATE TABLE "ProblemVariable" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userProblemSessionId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    CONSTRAINT "ProblemVariable_userProblemSessionId_fkey" FOREIGN KEY ("userProblemSessionId") REFERENCES "UserProblemSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
