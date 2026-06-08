import { Router, type IRouter } from "express";
import { eq, desc, sum, max, count } from "drizzle-orm";
import {
  db,
  participantsTable,
  repliesTable,
  payoutsTable,
  blocksTable,
} from "@workspace/db";
import {
  ListParticipantsResponse,
  GetParticipantResponse,
} from "@workspace/api-zod";
import {
  toParticipantDto,
  toReplyDto,
  toPayoutDto,
} from "../services/mappers";
import { enrichParticipant } from "../services/profileEnrich";
import { requireAdmin } from "../middleware/adminAuth";
import {
  computeTier,
  computeLevel,
  levelProgress,
  tierProgress,
  computeBadges,
  formatSocialHashrate,
} from "../services/gamification";

const router: IRouter = Router();

const CONFIRMED = new Set(["broadcast", "confirmed", "paid"]);

router.get("/participants", async (_req, res) => {
  const rows = await db
    .select()
    .from(participantsTable)
    .orderBy(desc(participantsTable.trustScore));
  res.json(ListParticipantsResponse.parse(rows.map(toParticipantDto)));
});

router.get("/participants/:handle", async (req, res) => {
  const raw = req.params.handle;
  const handle = (Array.isArray(raw) ? raw[0] : raw).replace(/^@/, "");
  const found = await db
    .select()
    .from(participantsTable)
    .where(eq(participantsTable.xHandle, handle))
    .limit(1);
  const participant = found[0];
  if (!participant) {
    res.status(404).json({ error: "Participant not found" });
    return;
  }

  const replyRows = await db
    .select({ reply: repliesTable, block: blocksTable })
    .from(repliesTable)
    .innerJoin(blocksTable, eq(repliesTable.blockId, blocksTable.id))
    .where(eq(repliesTable.participantId, participant.id));

  const payoutRows = await db
    .select({ payout: payoutsTable, block: blocksTable })
    .from(payoutsTable)
    .innerJoin(blocksTable, eq(payoutsTable.blockId, blocksTable.id))
    .where(eq(payoutsTable.participantId, participant.id));

  const totalEarnedItc = payoutRows
    .filter((p) => CONFIRMED.has(p.payout.status))
    .reduce((s, p) => s + p.payout.amountItc, 0);

  // ── Gamification stats ────────────────────────────────────────────────────
  const validReplies = replyRows.filter(
    (r) => r.reply.status === "valid" || r.reply.status === "settled",
  );
  const totalHashpower = validReplies.reduce(
    (s, r) => s + (r.reply.socialHashpower ?? 0),
    0,
  );
  const maxQuality = validReplies.reduce(
    (m, r) => Math.max(m, r.reply.qualityScore ?? 0),
    0,
  );
  const maxTrust = validReplies.reduce(
    (m, r) => Math.max(m, r.reply.trustWeight ?? 0),
    0,
  );
  const uniqueBlocks = new Set(validReplies.map((r) => r.reply.blockId)).size;
  const minBlockSeq =
    replyRows.length > 0
      ? Math.min(...replyRows.map((r) => r.block.seq))
      : null;

  // Rough "top miner" approximation: check if any payout is from a settled block
  // where this participant has the highest hashpower (simplified: trust > 0.8 && top quality)
  const hasTopRank = validReplies.some(
    (r) => r.reply.qualityScore >= 85 && r.reply.trustWeight >= 0.7,
  );

  const tier = computeTier(totalHashpower);
  const level = computeLevel(totalHashpower);
  const badges = computeBadges({
    validReplyCount: validReplies.length,
    totalHashpower,
    hasTopRank,
    maxQualityScore: maxQuality,
    blocksMinedCount: uniqueBlocks,
    minBlockSeq,
    maxTrustWeight: maxTrust,
  });
  const hashrate = formatSocialHashrate(totalHashpower, uniqueBlocks);

  res.json(
    GetParticipantResponse.parse({
      participant: {
        ...toParticipantDto(participant),
        // Gamification extensions (pass-through; Zod uses .passthrough or strip)
        displayName: participant.displayName,
        avatarUrl: participant.avatarUrl,
        kudosBio: participant.kudosBio,
        tier: tier.id,
        tierLabel: tier.label,
        tierIcon: tier.icon,
        tierColor: tier.color,
        tierProgress: tierProgress(totalHashpower),
        level,
        levelProgress: levelProgress(totalHashpower),
        totalHashpower,
        hashrate,
        badges: badges.map((b) => ({
          id: b.id,
          label: b.label,
          description: b.description,
          icon: b.icon,
          rarity: b.rarity,
        })),
        validReplyCount: validReplies.length,
        blocksMinedCount: uniqueBlocks,
      },
      replies: replyRows
        .sort((a, b) => b.reply.socialHashpower - a.reply.socialHashpower)
        .map(({ reply }) => toReplyDto(reply, participant)),
      payouts: payoutRows.map(({ payout, block }) =>
        toPayoutDto(payout, block.seq, participant.xHandle),
      ),
      totalEarnedItc,
    }),
  );
});

/** Admin: manually re-trigger profile enrichment for a handle. */
router.post("/participants/:handle/enrich", requireAdmin, async (req, res) => {
  const raw = req.params.handle;
  const handle = (Array.isArray(raw) ? raw[0] : raw).replace(/^@/, "");
  const found = await db
    .select()
    .from(participantsTable)
    .where(eq(participantsTable.xHandle, handle))
    .limit(1);
  if (!found[0]) {
    res.status(404).json({ error: "Participant not found" });
    return;
  }
  // Force re-enrich by clearing enrichedAt first
  await db
    .update(participantsTable)
    .set({ enrichedAt: null })
    .where(eq(participantsTable.id, found[0].id));
  enrichParticipant(found[0].id, handle, 0, 0).catch(() => {});
  res.json({ ok: true, message: `Enrichment triggered for @${handle}` });
});

export default router;
