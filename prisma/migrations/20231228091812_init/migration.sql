-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "superTokensUserId" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_superTokensUserId_key" ON "User"("superTokensUserId");
