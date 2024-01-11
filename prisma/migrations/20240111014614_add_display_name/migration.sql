-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "superTokensUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL
);
INSERT INTO "new_User" ("id", "createdAt", "updatedAt", "superTokensUserId", "displayName")
  SELECT "id", "createdAt", "updatedAt", "superTokensUserId",
  COALESCE("displayName", "superTokensUserId") FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_superTokensUserId_key" ON "User"("superTokensUserId");
CREATE INDEX "User_superTokensUserId_idx" ON "User"("superTokensUserId");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
