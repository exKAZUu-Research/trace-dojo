ALTER TABLE `ExerciseSession` ADD `problemType` text DEFAULT 'executionResult' NOT NULL;--> statement-breakpoint
ALTER TABLE `ExerciseSession` ADD `traceItemIndex` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ExerciseSession` ADD `traceItemCount` integer;--> statement-breakpoint
ALTER TABLE `ExerciseSubmission` ADD `problemType` text;--> statement-breakpoint
ALTER TABLE `ExerciseSubmission` ADD `traceItemIndex` integer;--> statement-breakpoint
ALTER TABLE `ExerciseSubmission` ADD `requestId` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ExerciseSubmission_sessionId_requestId_unique` ON `ExerciseSubmission` (`sessionId`,`requestId`) WHERE "ExerciseSubmission"."requestId" IS NOT NULL;