/*
  Warnings:

  - You are about to drop the `ProblemAnswerLog` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ProblemAnswerLog";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "UserAnswer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "problemType" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "isPassed" BOOLEAN NOT NULL,
    CONSTRAINT "UserAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
