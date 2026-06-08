import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";
import { db, repliesTable, participantsTable } from "@workspace/db";
import {
  ListRepliesResponse,
  ListRepliesResponseItem,
  SubmitReplyBody,
} from "@workspace/api-zod";
import { toReplyDto } from "../services/mappers";
import { getBlockBySeq } from "../services/queries";
import {
  ingestAndScoreReply,
  DuplicateReplyError,
  ScoringUnavailableError,
} from "../services/replyPipeline";
import { fetchTweetText } from "../services/integrations/netrows";
import { replyToTweet } from "../services/integrations/xPost";
import { recordAudit } from "../services/audit";

const router: IRouter = Router();

function parseSeq(raw: string | string[]): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ── GET /blocks/:seq/replies — public ────────────────────────────────────────

router.get("/blocks/:seq/replies", async (req, res) => {
  const seq = parseSeq(req.params.seq);
  if (seq === null) {
    res.json(ListRepliesResponse.parse([]));
    return;
  }
  const block = await getBlockBySeq(seq);
  if (!block) {
    res.json(ListRepliesResponse.parse([]));
    return;
  }
  const rows = await db
    .select({ reply: repliesTable, participant: participantsTable })
    .from(repliesTable)
    .innerJoin(participantsTable, eq(repliesTable.participantId, participantsTable.id))
    .where(eq(repliesTable.blockId, block.id));
  const dtos = rows
    .sort((a, b) => b.reply.socialHashpower - a.reply.socialHashpower)
    .map(({ reply, participant }) => toReplyDto(reply, participant));
  res.json(ListRepliesResponse.parse(dtos));
});

// ── POST /blocks/:seq/replies — PUBLIC (miner submission) ────────────────────
//
// Does NOT require admin auth. Identity/trust inputs are sourced ONLY from the
// trusted X adapter inside the pipeline — never from the client — so callers
// cannot inflate their own trust_weight or reach_factor.

router.post("/blocks/:seq/replies", async (req, res) => {
  const seq = parseSeq(req.params.seq);
  if (seq === null) {
    res.status(400).json({ error: "Invalid block sequence" });
    return;
  }
  const block = await getBlockBySeq(seq);
  if (!block) {
    res.status(400).json({ error: "Block not found" });
    return;
  }
  if (block.status !== "open") {
    res.status(400).json({ error: `Block is "${block.status}"; replies require an open block` });
    return;
  }

  const body = SubmitReplyBody.parse(req.body);
  const handle = body.handle.replace(/^@/, "").trim();

  // Resolve reply text: prefer fetching from X via xPostUrl (verified source),
  // fall back to explicit replyText for admin/test submissions.
  let replyText: string;
  let xReplyId: string | undefined;

  if (body.xPostUrl) {
    // Extract tweet id and username from URL
    const urlMatch = body.xPostUrl.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
    const urlUsername = urlMatch?.[1];
    const tweetId = urlMatch?.[2];
    if (!tweetId || !urlUsername) {
      res.status(400).json({ error: "Could not extract tweet ID from xPostUrl" });
      return;
    }
    xReplyId = tweetId;
    console.log(`[Reply] xPostUrl parsed: user=${urlUsername} tweet=${tweetId}`);

    // Fetch tweet text from X via NetRows (uses user's recent tweets + ID match)
    const fetched = await fetchTweetText(tweetId, urlUsername, req.log);
    if (!fetched) {
      // Tweet couldn't be fetched — accept submission but mark for review
      replyText = `[X post: ${body.xPostUrl}]`;
      console.log(`[Reply] NetRows fetch failed, using placeholder`);
      req.log?.warn({ tweetId, urlUsername, handle }, "Could not fetch tweet text; stored URL placeholder");
    } else {
      replyText = fetched;
      console.log(`[Reply] NetRows fetched tweet text (${fetched.length} chars)`);
    }
  } else if (body.replyText) {
    replyText = body.replyText;
    console.log(`[Reply] Using raw replyText (${replyText.length} chars)`);
  } else {
    res.status(400).json({ error: "Provide xPostUrl or replyText" });
    return;
  }

  console.log(`[Reply] Entering pipeline: handle=${handle} xReplyId=${xReplyId ?? "none"} text="${replyText.slice(0, 80)}..."`);

  try {
    const result = await ingestAndScoreReply(
      block,
      {
        handle,
        replyText,
        xReplyId,
        miningKeyHash: body.miningKeyHash,
      },
      req.log,
    );
    if (!result) {
      // Pipeline returns null ONLY when xReplyId was already ingested (dedup).
      console.log(`[Reply] Pipeline returned null — tweet already ingested (xReplyId=${xReplyId})`);
      res.status(409).json({ error: "Nice try miner — this tweet was already scored! Each post can only be mined once. ⛏️" });
      return;
    }
    console.log(`[Reply] Pipeline OK — status=${result.reply.status} hp=${result.reply.socialHashpower}`);
    const { reply, participant } = result;
    res.status(201).json(ListRepliesResponseItem.parse(toReplyDto(reply, participant)));
  } catch (err) {
    if (err instanceof DuplicateReplyError) {
      console.log(`[Reply] DuplicateReplyError: ${err.message}`);
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof ScoringUnavailableError) {
      console.error(`[Reply] ScoringUnavailableError: ${err.message}`);
      res.status(502).json({ error: err.message });
      return;
    }
    console.error(`[Reply] Unhandled error:`, err);
    throw err;
  }
});

// ── Admin reply management ───────────────────────────────────────────────────

router.patch("/replies/:id/flag", requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  await db.update(repliesTable).set({ flagged: true }).where(eq(repliesTable.id, id));
  res.json({ ok: true });
});

/**
 * POST /replies/:id/post-x-reply
 * HITL operator action: post the AI-drafted reply to X (or a custom edited version).
 *   body.text — optional override; if absent, uses stored aiReplyText
 * Requires the submitting miner's xReplyId to be set (so we know which tweet to reply to).
 */
router.post("/replies/:id/post-x-reply", requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const overrideText: string | undefined = typeof req.body?.text === "string" ? req.body.text.trim() : undefined;

  const rows = await db
    .select({ reply: repliesTable, participant: participantsTable })
    .from(repliesTable)
    .innerJoin(participantsTable, eq(repliesTable.participantId, participantsTable.id))
    .where(eq(repliesTable.id, id))
    .limit(1);

  if (!rows[0]) {
    res.status(404).json({ error: "Reply not found" });
    return;
  }

  const { reply, participant } = rows[0];

  if (reply.aiXReplyStatus === "posted") {
    res.status(409).json({ error: "Already posted" });
    return;
  }

  const replyText = overrideText || reply.aiReplyText;
  if (!replyText) {
    res.status(400).json({ error: "No AI reply text available. Score this reply first." });
    return;
  }

  if (!reply.xReplyId) {
    res.status(400).json({ error: "No xReplyId on this reply — cannot reply on X without the source tweet ID." });
    return;
  }

  try {
    const posted = await replyToTweet(reply.xReplyId, replyText, req.log);
    await db.update(repliesTable).set({
      aiXReplyStatus: "posted",
      aiXReplyId: posted.id,
      // If admin edited the text, persist the final version
      ...(overrideText ? { aiReplyText: overrideText } : {}),
    }).where(eq(repliesTable.id, id));
    await recordAudit({
      actor: "admin",
      action: "hitl.post_x_reply",
      entity: "reply",
      entityId: id,
      detail: { handle: participant.xHandle, tweetId: posted.id, url: posted.url },
    });
    res.json({ ok: true, tweetId: posted.id, url: posted.url });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "X post failed";
    if (msg.includes("not configured")) {
      res.status(503).json({ error: "X write credentials not configured. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET." });
      return;
    }
    req.log?.error({ err }, "post-x-reply failed");
    throw err;
  }
});

router.patch("/replies/:id/skip-x-reply", requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  await db.update(repliesTable).set({ aiXReplyStatus: "skipped" }).where(eq(repliesTable.id, id));
  res.json({ ok: true });
});

// ── GET /admin/pending-x-replies — HITL replies across all blocks ─────────────
// Returns all replies that haven't been posted or skipped yet (loose filter).
router.get("/admin/pending-x-replies", requireAdmin, async (req, res) => {
  const rows = await db
    .select({
      reply: repliesTable,
      participant: participantsTable,
    })
    .from(repliesTable)
    .innerJoin(participantsTable, eq(repliesTable.participantId, participantsTable.id));

  const items = rows
    .filter(r => r.reply.aiXReplyStatus !== "posted" && r.reply.aiXReplyStatus !== "skipped")
    .map(r => ({
      id: r.reply.id,
      blockId: r.reply.blockId,
      handle: r.participant.xHandle,
      xReplyId: r.reply.xReplyId,
      replyText: r.reply.replyText,
      aiReplyText: r.reply.aiReplyText ?? r.reply.replyText,
      aiXReplyStatus: r.reply.aiXReplyStatus,
      qualityScore: r.reply.qualityScore,
      socialHashpower: r.reply.socialHashpower,
      createdAt: r.reply.createdAt,
    }));

  res.json(items);
});

export default router;
