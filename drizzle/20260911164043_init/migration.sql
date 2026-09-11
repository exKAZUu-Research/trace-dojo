-- Existing databases must have all migrations through add_fill_in_blank_columns applied.
CREATE TABLE IF NOT EXISTS `ProblemSession` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`createdAt` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text NOT NULL,
	`courseId` text NOT NULL,
	`lectureId` text NOT NULL,
	`problemId` text NOT NULL,
	`problemVariablesSeed` text NOT NULL,
	`problemType` text NOT NULL,
	`traceItemIndex` integer NOT NULL,
	`elapsedMilliseconds` integer DEFAULT 0 NOT NULL,
	`completedAt` integer,
	CONSTRAINT `fk_ProblemSession_userId_User_id_fk` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ProblemSubmission` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`createdAt` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`sessionId` integer NOT NULL,
	`problemType` text NOT NULL,
	`traceItemIndex` integer NOT NULL,
	`elapsedMilliseconds` integer NOT NULL,
	`isCorrect` integer NOT NULL,
	`answers` text,
	`gradingStage` integer,
	CONSTRAINT `fk_ProblemSubmission_sessionId_ProblemSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `ProblemSession`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `User` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updatedAt` integer NOT NULL,
	`displayName` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ProblemSession_userId_courseId_lectureId_problemId_completedAt_idx` ON `ProblemSession` (`userId`,`courseId`,`lectureId`,`problemId`,`completedAt`);
--> statement-breakpoint
UPDATE `User` SET `createdAt` = CAST(round((julianday(`createdAt`) - 2440587.5) * 86400000) AS INTEGER) WHERE typeof(`createdAt`) = 'text';
--> statement-breakpoint
UPDATE `User` SET `updatedAt` = CAST(round((julianday(`updatedAt`) - 2440587.5) * 86400000) AS INTEGER) WHERE typeof(`updatedAt`) = 'text';
--> statement-breakpoint
UPDATE `ProblemSession` SET `createdAt` = CAST(round((julianday(`createdAt`) - 2440587.5) * 86400000) AS INTEGER) WHERE typeof(`createdAt`) = 'text';
--> statement-breakpoint
UPDATE `ProblemSession` SET `updatedAt` = CAST(round((julianday(`updatedAt`) - 2440587.5) * 86400000) AS INTEGER) WHERE typeof(`updatedAt`) = 'text';
--> statement-breakpoint
UPDATE `ProblemSession` SET `completedAt` = CAST(round((julianday(`completedAt`) - 2440587.5) * 86400000) AS INTEGER) WHERE typeof(`completedAt`) = 'text';
--> statement-breakpoint
UPDATE `ProblemSubmission` SET `createdAt` = CAST(round((julianday(`createdAt`) - 2440587.5) * 86400000) AS INTEGER) WHERE typeof(`createdAt`) = 'text';
