import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";

export const repliesTable = sqliteTable("replies", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  blockId: text("block_id").notNull(),
  participantId: text("participant_id").notNull(),
  xReplyId: text("x_reply_id").unique(),
  replyText: text("reply_text").notNull().default(""),
  contentHash: text("content_hash").notNull().default(""),
  tokenSignature: text("token_signature", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  qualityScore: real("quality_score").notNull().default(0),
  aiScores: text("ai_scores", { mode: "json" }).$type<Record<
    string,
    number | boolean | string
  > | null>(),
  trustWeight: real("trust_weight").notNull().default(0),
  uniqueness: real("uniqueness").notNull().default(1),
  reachFactor: real("reach_factor").notNull().default(1),
  socialHashpower: real("social_hashpower").notNull().default(0),
  status: text("status").notNull().default("ingested"),
  rejectionReason: text("rejection_reason"),
  flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
  /** AiAS-generated on-site comment + HITL X reply queue. */
  aiReplyText: text("ai_reply_text"),
  /**
   * HITL status for the AI-drafted X reply:
   *   pending  — generated, awaiting operator review
   *   posted   — operator approved and @interchained tweeted it
   *   skipped  — operator dismissed without posting
   */
  aiXReplyStatus: text("ai_x_reply_status"),
  /** Tweet id of the reply posted to X after operator approval. */
  aiXReplyId: text("ai_x_reply_id"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdate(() => new Date().toISOString()),
});

export type Reply = typeof repliesTable.$inferSelect;
export type InsertReply = typeof repliesTable.$inferInsert;
