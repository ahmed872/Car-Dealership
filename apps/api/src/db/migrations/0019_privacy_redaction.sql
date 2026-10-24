ALTER TABLE "message_log" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_log" ADD COLUMN "redacted_by" uuid;--> statement-breakpoint
ALTER TABLE "showroom_inquiries" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "showroom_inquiries" ADD COLUMN "redacted_by" uuid;