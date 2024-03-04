/*
  Warnings:

  - You are about to drop the `UserSolvedProblem` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "UserSolvedProblem";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "UserCompletedProblem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    CONSTRAINT "UserCompletedProblem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
