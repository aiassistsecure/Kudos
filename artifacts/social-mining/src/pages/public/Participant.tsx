import { useState } from "react";
import { useGetParticipant, getGetParticipantQueryKey, useWalletBind } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { useMinerIdentity } from "@/hooks/useMinerIdentity";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatItc } from "@/lib/utils";

const RARITY_STYLES: Record<string, string> = {
  common:    "border-muted-foreground/40 text-muted-foreground bg-muted/20",
  rare:      "border-blue-400/70 text-blue-400 bg-blue-400/10",
  epic:      "border-purple-400/70 text-purple-400 bg-purple-400/10",
  legendary: "border-yellow-400/70 text-yellow-400 bg-yellow-400/10",
};

function TierBadge({ icon, label, color }: { icon?: string; label?: string; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1 font-mono text-sm font-bold border-2 border-foreground brutal-shadow"
      style={{ background: color ? `${color}22` : undefined, borderColor: color ?? undefined, color: color ?? undefined }}
    >
      {icon} {label}
    </span>
  );
}

function StatBar({ label, value, max = 100, color = "bg-primary" }: {
  label: string; value: number; max?: number; color?: string;
}) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between font-mono text-xs font-bold">
        <span className="text-muted-foreground uppercase">{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-3 bg-muted border border-foreground/20 overflow-hidden">
        <div className={`h-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function Participant() {
  const params = useParams();
  const handle = (params.handle || "").replace(/^@/, "");

  const { data, isLoading } = useGetParticipant(handle, {
    query: { enabled: !!handle, queryKey: getGetParticipantQueryKey(handle) },
  });
  const { identity, setWalletAddress, setEmail: setIdentityEmail } = useMinerIdentity();
  const isOwnProfile = identity?.xHandle?.toLowerCase() === handle.toLowerCase();
  const walletBind = useWalletBind();
  const { toast } = useToast();
  const [editWallet, setEditWallet] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editingWallet, setEditingWallet] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [copied, setCopied] = useState(false);

  if (isLoading) return (
    <div className="space-y-6 animate-pulse">
      <div className="h-48 bg-muted border-4 border-foreground brutal-shadow" />
      <div className="h-32 bg-muted border-4 border-foreground brutal-shadow" />
    </div>
  );
  if (!data) return (
    <div className="p-16 text-center border-4 border-foreground bg-card brutal-shadow">
      <div className="text-6xl mb-4">⛏</div>
      <div className="font-black text-2xl uppercase">Miner Not Found</div>
      <div className="font-mono text-sm text-muted-foreground mt-2">@{handle} hasn't mined yet</div>
    </div>
  );

  const { participant: p, replies, payouts, totalEarnedItc } = data;
  const validReplies = replies.filter(r => r.status === "valid" || r.status === "settled");

  return (
    <div className="space-y-8 animate-in fade-in">

      {/* ── Profile Hero ── */}
      <div className="border-4 border-foreground bg-card brutal-shadow overflow-hidden">
        {/* Tier color strip */}
        <div className="h-2" style={{ background: p.tierColor ?? "#a78bfa" }} />

        <div className="p-8 flex flex-col md:flex-row gap-8 items-start">
          {/* Avatar */}
          <div className="relative shrink-0">
            {p.avatarUrl ? (
              <img
                src={p.avatarUrl}
                alt={p.displayName ?? p.xHandle}
                className="w-24 h-24 border-4 border-foreground brutal-shadow object-cover"
                style={{ borderColor: p.tierColor ?? undefined }}
              />
            ) : (
              <div
                className="w-24 h-24 border-4 border-foreground brutal-shadow flex items-center justify-center text-4xl font-black bg-muted"
                style={{ borderColor: p.tierColor ?? undefined }}
              >
                {p.xHandle[0]?.toUpperCase()}
              </div>
            )}
            {/* Tier icon badge */}
            {p.tierIcon && (
              <div className="absolute -bottom-3 -right-3 w-8 h-8 bg-foreground text-background border-2 border-foreground flex items-center justify-center text-lg brutal-shadow">
                {p.tierIcon}
              </div>
            )}
          </div>

          {/* Name + Bio */}
          <div className="flex-1 space-y-3 min-w-0">
            <div>
              {p.displayName && (
                <div className="font-black text-3xl">{p.displayName}</div>
              )}
              <div className="flex items-center gap-3 flex-wrap mt-1">
                <span className="font-mono text-lg text-muted-foreground">@{p.xHandle}</span>
                {p.verified && (
                  <span className="text-blue-400 font-mono text-xs font-bold border border-blue-400/50 px-2 py-0.5">✓ Verified</span>
                )}
                {p.tier && (
                  <TierBadge icon={p.tierIcon} label={p.tierLabel} color={p.tierColor} />
                )}
              </div>
            </div>

            {/* Kudos AI bio */}
            {p.kudosBio ? (
              <div className="border-l-4 pl-4 font-medium text-base leading-relaxed"
                style={{ borderColor: p.tierColor ?? "hsl(var(--primary))" }}>
                {p.kudosBio}
              </div>
            ) : (
              <div className="font-mono text-sm text-muted-foreground italic">
                Mining bio generating…
              </div>
            )}

            {/* Social + follow */}
            <div className="flex flex-wrap gap-3">
              <a
                href={`https://x.com/${p.xHandle}`}
                target="_blank" rel="noopener noreferrer"
                className="border-2 border-foreground bg-secondary text-secondary-foreground px-4 py-1.5 font-mono text-sm font-bold brutal-shadow hover:-translate-y-0.5 transition-transform"
              >
                Follow on X →
              </a>
              <div className="border-2 border-foreground bg-muted px-4 py-1.5 font-mono text-sm font-bold">
                {p.followersCount.toLocaleString()} Followers
              </div>
            </div>
          </div>

          {/* ITC Earnings */}
          <div className="shrink-0 text-right space-y-1 border-4 border-foreground p-4 brutal-shadow bg-primary/5 min-w-[140px]">
            <div className="font-mono text-xs font-bold uppercase text-muted-foreground">Total Earned</div>
            <div className="text-3xl font-black text-primary">{formatItc(totalEarnedItc)}</div>
            <div className="font-mono text-xs text-muted-foreground">ITC</div>
            <div className="text-xl font-black mt-2">Lv.{p.level ?? 1}</div>
            <div className="font-mono text-xs text-muted-foreground">{p.hashrate ?? "0 H/block"}</div>
          </div>
        </div>
      </div>

      {/* ── Own Profile: Wallet & Settings ── */}
      {isOwnProfile && identity && (
        <div className="grid md:grid-cols-2 gap-6">
          {/* Wallet */}
          <div className="border-4 border-foreground bg-card brutal-shadow p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-black uppercase text-lg">💰 Payout Wallet</h2>
              {!editingWallet && (
                <Button
                  variant="outline"
                  onClick={() => { setEditWallet(identity.walletAddress); setEditingWallet(true); }}
                  className="rounded-none border-2 border-foreground h-7 text-xs"
                >
                  {identity.walletAddress ? "Change" : "Set Address"}
                </Button>
              )}
            </div>
            {editingWallet ? (
              <div className="space-y-2">
                <Input
                  value={editWallet}
                  onChange={e => setEditWallet(e.target.value)}
                  placeholder="itc1… or base58 address"
                  className="border-2 border-foreground rounded-none shadow-none font-mono text-sm"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      const addr = editWallet.trim();
                      if (!addr) return;
                      setWalletAddress(addr);
                      walletBind.mutate({ data: { handle: identity.xHandle, itcAddress: addr } }, {
                        onSuccess: () => { toast({ title: "Wallet saved", description: `${addr.slice(0, 16)}…` }); setEditingWallet(false); },
                        onError: () => toast({ title: "Error", description: "Failed to bind wallet", variant: "destructive" }),
                      });
                    }}
                    disabled={!editWallet.trim() || walletBind.isPending}
                    className="flex-1 rounded-none border-2 border-foreground brutal-shadow bg-primary text-primary-foreground h-9 text-xs"
                  >
                    {walletBind.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button variant="outline" onClick={() => setEditingWallet(false)} className="rounded-none border-2 border-foreground h-9 text-xs">Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="font-mono text-sm border-2 border-foreground/30 bg-muted/20 p-3">
                {identity.walletAddress || <span className="text-muted-foreground italic">No wallet set — set one to receive ITC payouts</span>}
              </div>
            )}
          </div>

          {/* Mining Key */}
          <div className="border-4 border-primary bg-primary/5 brutal-shadow p-6 space-y-3">
            <h2 className="font-black uppercase text-lg">🔑 Mining Key</h2>
            <p className="font-mono text-[10px] text-muted-foreground">Save this key — restore your profile on any browser.</p>
            <div
              className="font-mono text-lg font-black tracking-widest select-all bg-background border-2 border-foreground p-3 text-center cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={async () => { await navigator.clipboard.writeText(identity.miningKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            >
              {identity.miningKey}
            </div>
            <Button
              variant="outline"
              onClick={async () => { await navigator.clipboard.writeText(identity.miningKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="w-full rounded-none border-2 border-primary h-8 font-mono text-xs"
            >
              {copied ? "✓ Copied!" : "📋 Copy to Clipboard"}
            </Button>
          </div>
        </div>
      )}

      {/* ── Gamification Row ── */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Level + Tier bars */}
        <div className="border-4 border-foreground bg-card brutal-shadow p-6 space-y-5">
          <h2 className="font-black uppercase text-lg">Mining Progress</h2>

          <div className="space-y-1">
            <div className="flex justify-between font-mono text-xs font-bold">
              <span className="text-muted-foreground uppercase">Level {p.level ?? 1}</span>
              <span>{p.levelProgress ?? 0}% to Lv.{(p.level ?? 1) + 1}</span>
            </div>
            <div className="h-4 bg-muted border-2 border-foreground overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-700"
                style={{ width: `${p.levelProgress ?? 0}%` }}
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between font-mono text-xs font-bold">
              <span className="text-muted-foreground uppercase">{p.tierLabel ?? "Prospector"} Tier</span>
              <span>{p.tierProgress ?? 0}% to next</span>
            </div>
            <div className="h-4 bg-muted border-2 border-foreground overflow-hidden">
              <div
                className="h-full transition-all duration-700"
                style={{ width: `${p.tierProgress ?? 0}%`, background: p.tierColor ?? "#a78bfa" }}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="border-2 border-foreground bg-muted/30 p-3 text-center font-mono">
              <div className="text-2xl font-black">{p.validReplyCount ?? 0}</div>
              <div className="text-[10px] uppercase text-muted-foreground">Valid Replies</div>
            </div>
            <div className="border-2 border-foreground bg-muted/30 p-3 text-center font-mono">
              <div className="text-2xl font-black">{p.blocksMinedCount ?? 0}</div>
              <div className="text-[10px] uppercase text-muted-foreground">Blocks Mined</div>
            </div>
            <div className="border-2 border-foreground bg-muted/30 p-3 text-center font-mono">
              <div className="text-2xl font-black">{Math.round(p.totalHashpower ?? 0).toLocaleString()}</div>
              <div className="text-[10px] uppercase text-muted-foreground">Total HP</div>
            </div>
          </div>
        </div>

        {/* Badges */}
        <div className="border-4 border-foreground bg-card brutal-shadow p-6 space-y-4">
          <h2 className="font-black uppercase text-lg">Badges</h2>
          {!p.badges || p.badges.length === 0 ? (
            <div className="p-8 text-center font-mono text-sm text-muted-foreground border-2 border-dashed border-foreground/20">
              Mine your first block to earn badges
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {p.badges.map((badge) => (
                <div
                  key={badge.id}
                  title={badge.description}
                  className={`border-2 p-3 space-y-1 cursor-help transition-transform hover:-translate-y-0.5 ${RARITY_STYLES[badge.rarity] ?? RARITY_STYLES.common}`}
                >
                  <div className="text-2xl">{badge.icon}</div>
                  <div className="font-mono text-xs font-bold uppercase">{badge.label}</div>
                  <div className="font-mono text-[10px] uppercase opacity-70">{badge.rarity}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Mining History ── */}
      <div className="space-y-4">
        <h2 className="text-2xl font-black uppercase tracking-tighter border-b-4 border-foreground pb-2">
          Mining History
          <span className="ml-3 font-mono text-base font-normal text-muted-foreground">({replies.length} submissions)</span>
        </h2>

        {replies.length === 0 ? (
          <div className="border-4 border-foreground bg-card p-12 text-center brutal-shadow font-mono text-muted-foreground">
            No submissions yet
          </div>
        ) : (
          <div className="space-y-4">
            {replies.slice(0, 20).map((reply) => (
              <div key={reply.id} className="border-4 border-foreground bg-card brutal-shadow">
                {/* Submission */}
                <div className="p-5 space-y-3">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <span className={`px-2 py-0.5 text-xs font-mono font-bold uppercase border-2 border-foreground ${
                      reply.status === "valid" || reply.status === "settled"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {reply.status === "valid" || reply.status === "settled" ? "✓ Valid" : reply.status}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      Q: <strong>{reply.qualityScore.toFixed(1)}</strong> · HP: <strong className="text-primary">{reply.socialHashpower.toFixed(0)}</strong>
                    </span>
                  </div>
                  <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap">{reply.replyText}</p>
                </div>

                {/* AI comment */}
                {reply.aiReplyText && (
                  <div className="border-t-2 border-foreground/20 bg-primary/5 px-5 py-4 flex gap-3 items-start">
                    <div className="shrink-0 mt-0.5 w-7 h-7 bg-foreground text-background flex items-center justify-center font-black text-xs border-2 border-foreground">
                      AI
                    </div>
                    <div>
                      <div className="font-mono text-[10px] font-bold uppercase text-muted-foreground mb-0.5">Kudos AI · in response</div>
                      <p className="text-sm font-medium leading-relaxed">{reply.aiReplyText}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
