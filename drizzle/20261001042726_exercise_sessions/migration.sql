CREATE TABLE `ExerciseSession` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`createdAt` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`userId` text NOT NULL,
	`courseId` text NOT NULL,
	`lectureId` text NOT NULL,
	`learningMode` text NOT NULL,
	`problemFormat` text NOT NULL,
	`problemId` text NOT NULL,
	`seed` text NOT NULL,
	`problemType` text NOT NULL,
	`traceItemIndex` integer NOT NULL,
	`completedAt` integer,
	CONSTRAINT `fk_ExerciseSession_userId_User_id_fk` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `ExerciseSubmission` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`createdAt` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`sessionId` integer NOT NULL,
	`answers` text,
	`status` text NOT NULL,
	`gradingStage` integer,
	`problemType` text,
	`traceItemIndex` integer,
	`requestId` text,
	CONSTRAINT `fk_ExerciseSubmission_sessionId_ExerciseSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `ExerciseSession`(`id`) ON UPDATE CASCADE ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `ExerciseSession_user_lecture_mode_created_idx` ON `ExerciseSession` (`userId`,`courseId`,`lectureId`,`learningMode`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ExerciseSubmission_sessionId_idx` ON `ExerciseSubmission` (`sessionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `ExerciseSubmission_sessionId_requestId_unique` ON `ExerciseSubmission` (`sessionId`,`requestId`) WHERE "ExerciseSubmission"."requestId" IS NOT NULL;