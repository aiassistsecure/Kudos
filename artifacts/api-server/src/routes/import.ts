import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, blocksTable } from "@workspace/db";
import { ImportXPostsResponse } from "@workspace/api-zod";
import { requireAdmin } from "../middleware/adminAuth";
import { importReferencePosts } from "../services/importPosts";
import { recordAudit } from "../services/audit";
import { fetchRecentUserPosts } from "../services/integrations/netrows";
import { computeBlockReward } from "../services/rewardModel";

const router: IRouter = Router();

function titleFromText(text: string): string {
  const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  if (!firstLine) return "Imported X post";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/**
 * Import X posts saved by scripts/import_x_posts.py into the blocks table as
 * real reward-earning blocks at the lowest heights (earliest post = block 0),
 * created "closed" and awaiting settlement.
 */
router.post("/admin/import-posts", requireAdmin, async (_req, res) => {
  const result = await importReferencePosts();
  await recordAudit({
    actor: "admin",
    action: "posts.import",
    entity: "blocks",
    detail: result,
  });
  res.json(ImportXPostsResponse.parse(result));
});

/**
 * Fetch a user's recent tweets from NetRows and import them directly as
 * open blocks awaiting reply sync and settlement.
 */
router.post("/admin/sync-recent-posts", requireAdmin, async (req, res) => {
  try {
    const { username, limit } = req.body;
    if (!username) {
      res.status(400).json({ error: "Username is required" });
      return;
    }
    const cleanUsername = username.replace(/^@/, "").trim();
    if (!cleanUsername) {
      res.status(400).json({ error: "Invalid username" });
      return;
    }
    const maxLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);

    const posts = await fetchRecentUserPosts(cleanUsername, maxLimit, req.log);
    if (!posts) {
      res.status(400).json({ error: "Failed to fetch posts from NetRows. Check NETROWS_API_KEY." });
      return;
    }

    const existing = await db
      .select({ xPostId: blocksTable.xPostId })
      .from(blocksTable);
    const existingIds = new Set(
      existing.map((e) => e.xPostId).filter((v): v is string => Boolean(v)),
    );

    const maxRow = await db
      .select({ seq: blocksTable.seq })
      .from(blocksTable)
      .orderBy(desc(blocksTable.seq))
      .limit(1);
    let seq = maxRow.length > 0 ? maxRow[0].seq : -1;

    const reward = await computeBlockReward(req.log);

    let imported = 0;
    let skipped = 0;

    // Oldest first so block heights increase chronologically
    for (const p of [...posts].reverse()) {
      if (!p.id || existingIds.has(p.id)) {
        skipped += 1;
        continue;
      }
      seq += 1;
      const text = p.text ?? "";
      await db.insert(blocksTable).values({
        seq,
        xPostId: p.id,
        xPostUrl: p.url ?? `https://x.com/${cleanUsername}/status/${p.id}`,
        postContent: text,
        xPostedAt: new Date().toISOString(),
        postMode: "imported",
        title: titleFromText(text),
        topic: "",
        rewardItc: reward.rewardItc,
        sponsor: `Imported from X (@${cleanUsername})`,
        status: "open",
        opensAt: new Date().toISOString(),
      });
      existingIds.add(p.id);
      imported += 1;
    }

    const result = {
      imported,
      skipped,
      available: posts.length,
    };

    await recordAudit({
      actor: "admin",
      action: "posts.sync_recent",
      entity: "blocks",
      detail: result,
    });

    res.json(ImportXPostsResponse.parse(result));
  } catch (err) {
    req.log?.error({ err }, "Failed to sync recent posts");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
