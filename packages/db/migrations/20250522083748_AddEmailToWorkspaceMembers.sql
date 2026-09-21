ALTER TABLE "workspace_members" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "email" varchar(255);--> statement-breakpoint
UPDATE "workspace_members" wm SET "email" = u."email" FROM "user" u WHERE wm."userId" = u."id";--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "email" SET NOT NULL;