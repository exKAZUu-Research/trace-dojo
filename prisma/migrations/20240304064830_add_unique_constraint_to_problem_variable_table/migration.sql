/*
  Warnings:

  - A unique constraint covering the columns `[userProblemSessionId,position]` on the table `ProblemVariable` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ProblemVariable_userProblemSessionId_position_key" ON "ProblemVariable"("userProblemSessionId", "position");
