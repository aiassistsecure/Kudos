import { useState, useId } from "react";
import {
  useGetBlock, getGetBlockQueryKey,
  useListReplies, getListRepliesQueryKey,
  useSubmitReply,
  type SubmitReplyInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { formatItc } from "@/lib/utils";
import { useMinerIdentity } from "@/hooks/useMinerIdentity";
import { useToast } from "@/hooks/use-toast";
import { useCountdown } from "@/hooks/useCountdown";
import Hashpit from "@/components/Hashpit";
import { OnboardingModal } from "@/components/OnboardingModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type MiningStep =
  | "idle"
  | "checking-key"
  | "extracting"
  | "submitting"
  | "scoring"
  | "complete"
  | "error";

interface ParsedXUrl {
  handle: string;
  tweetId: string;
  tweetUrl: string;
}

interface PendingReply {
  id: string;
  handle: string;
  replyText: string;
  status: "pending" | "failed";
}

// ── URL parser ────────────────────────────────────────────────────────────────

/**
 * Forgiving X/Twitter URL parser. Accepts:
 *   https://x.com/handle/status/123
 *   https://twitter.com/handle/status/123
 *   x.com/handle/status/123          (no protocol)
 *   twitter.com/handle/status/123
 *
 * Returns null if the URL doesn't contain /status/<id>.
 */
function parseXUrl(raw: string): ParsedXUrl | null {
  let normalized = raw.trim();

  // Auto-add protocol if missing
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;

  // Path must be /<handle>/status/<id>
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] !== "status") return null;

  const handle = parts[0];
  const tweetId = parts[2];
  if (!handle || !tweetId || !/^\d+$/.test(tweetId)) return null;

  return {
    handle,
    tweetId,
    tweetUrl: `https://x.com/${handle}/status/${tweetId}`,
  };
}

// ── Mining step UI ─────────────────────────────────────────────────────────────

const STEPS: Record<MiningStep, { icon: string; label: string } | null> = {
  idle:          null,
  "checking-key": { icon: "⛏️",  label: "Preparing Mining Key…" },
  extracting:    { icon: "🔗",  label: "Reading X post URL…" },
  submitting:    { icon: "🧠",  label: "Scoring signal…" },
  scoring:       { icon: "💬",  label: "Writing AI comment…" },
  complete:      { icon: "✅",  label: "Submission mined" },
  error:         { icon: "⚠️",  label: "Something went wrong" },
};

const STEP_ORDER: MiningStep[] = [
  "checking-key", "extracting", "submitting", "scoring", "complete"
];

function MiningProgressBar({ step }: { step: MiningStep }) {
  const current = STEP_ORDER.indexOf(step);
  return (
    <div className="border-4 border-primary bg-primary/5 p-5 space-y-3 brutal-shadow animate-in fade-in duration-300">
      <div className="font-mono text-xs font-bold uppercase text-primary tracking-widest">
        Mining in progress
      </div>
      <div className="space-y-2">
        {STEP_ORDER.filter(s => s !== "complete").map((s, i) => {
          const info = STEPS[s]!;
          const done = i < current;
          const active = i === current;
          return (
            <div
              key={s}
              className={`flex items-center gap-3 font-mono text-sm transition-all duration-300 ${
                done   ? "opacity-40 line-through text-muted-foreground" :
                active ? "text-foreground font-bold" :
                         "opacity-25 text-muted-foreground"
              }`}
            >
              <span className={`text-base ${active ? "animate-bounce" : ""}`}>
                {info.icon}
              </span>
              <span className="flex-1">{info.label}</span>
              {done && <span className="text-primary text-xs">✓</span>}
              {active && (
                <span className="flex gap-0.5">
                  {[0, 1, 2].map(d => (
                    <span
                      key={d}
                      className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse"
                      style={{ animationDelay: `${d * 150}ms` }}
                    />
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Pending reply card ────────────────────────────────────────────────────────

function PendingReplyCard({ entry }: { entry: PendingReply }) {
  const isFailed = entry.status === "failed";
  return (
    <div className={`border-4 brutal-shadow animate-in fade-in duration-500 ${
      isFailed ? "border-destructive bg-destructive/5" : "border-primary/50 bg-primary/5"
    }`}>
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-3">
          <span className="font-black text-lg">@{entry.handle}</span>
          <span className={`px-2 py-0.5 text-xs font-mono font-bold uppercase border-2 border-foreground ${
            isFailed ? "bg-destructive/20 text-destructive border-destructive" : "bg-primary/10 text-primary border-primary/50"
          }`}>
            {isFailed ? "⚠ Score failed" : "⛏ Scoring…"}
          </span>
        </div>
        {isFailed ? (
          <p className="font-mono text-xs text-destructive">
            Submission received, scoring failed. Operator review needed.
          </p>
        ) : (
          <div className="space-y-1.5">
            <div className="h-2 bg-primary/20 w-3/4 animate-pulse rounded-sm" />
            <div className="h-2 bg-primary/10 w-1/2 animate-pulse rounded-sm" />
            <div className="font-mono text-xs text-muted-foreground italic">
              AI comment generating…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Submit form ───────────────────────────────────────────────────────────────

function MineSubmitForm({
  blockSeq,
  isOpen,
}: {
  blockSeq: number;
  isOpen: boolean;
}) {
  const uid = useId();
  const { identity, isOnboarded, setXHandle, setWalletAddress, setEmail, completeOnboarding, saveSeed } = useMinerIdentity();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { mutateAsync: doSubmitReply } = useSubmitReply();

  const [step, setStep] = useState<MiningStep>("idle");
  const [urlInput, setUrlInput] = useState("");
  const [handleInput, setHandleInput] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingEntry, setPendingEntry] = useState<PendingReply | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  if (!isOpen) return null;

  const savedHandle = identity?.xHandle ?? "";
  const isFirstTime = !savedHandle;

  const buttonLabel: Record<MiningStep, string> = {
    idle:           "Mine This Reply",
    "checking-key": "Mining…",
    extracting:     "Mining…",
    submitting:     "Mining…",
    scoring:        "Mining…",
    complete:       "Mined ⚡",
    error:          "Try Again",
  };
  const isDisabled = ["checking-key", "extracting", "submitting", "scoring"].includes(step);

  // Advance animation through steps while request is in-flight
  const animateSteps = (onDone: () => void) => {
    const order: MiningStep[] = ["checking-key", "extracting", "submitting", "scoring"];
    let i = 0;
    setStep(order[0]);
    const tick = () => {
      i++;
      if (i < order.length) {
        setTimeout(() => { setStep(order[i]); tick(); }, 650 + Math.random() * 350);
      } else {
        onDone();
      }
    };
    setTimeout(tick, 700);
  };

  const handleSubmit = async () => {
    setErrorMsg(null);
    if (step === "complete") { setStep("idle"); setUrlInput(""); return; }

    // 1. Resolve handle
    const finalHandle = (isFirstTime ? handleInput : savedHandle).replace(/^@/, "").trim();
    if (!finalHandle) {
      setErrorMsg("Enter your X handle so we can verify your post.");
      return;
    }

    // 2. Parse X URL
    const parsed = parseXUrl(urlInput);
    if (!parsed) {
      setErrorMsg("Paste a valid X post URL so Kudos can mine your reply.");
      return;
    }

    // 3. Warn on handle mismatch (soft — NetRows verifies server-side too)
    if (parsed.handle.toLowerCase() !== finalHandle.toLowerCase()) {
      setErrorMsg(
        `This URL looks like it belongs to @${parsed.handle}, not @${finalHandle}. Check your URL.`
      );
      return;
    }

    // 4. Save identity for returning visits
    if (isFirstTime) {
      setXHandle(finalHandle);
      saveSeed();
    }

    // 5. Optimistic pending card
    const tempId = `pending-${uid}-${Date.now()}`;
    setPendingEntry({ id: tempId, handle: finalHandle, replyText: "", status: "pending" });

    // 6. Start animation + request in parallel
    let requestDone = false;
    let requestResult: "ok" | "error" = "ok";

    animateSteps(() => {
      // Animation done — wait for request if needed then finalize
      const finish = () => {
        if (requestResult === "ok") {
          setStep("complete");
          setPendingEntry(null);
          queryClient.invalidateQueries({ queryKey: getListRepliesQueryKey(blockSeq) });
          queryClient.invalidateQueries({ queryKey: getGetBlockQueryKey(blockSeq) });
          toast({
            title: "Block mined. ⚡",
            description: "Your reply was scored and added to the social hashstream.",
          });
          setUrlInput("");
        } else {
          setStep("error");
          setPendingEntry(prev => prev ? { ...prev, status: "failed" } : null);
        }
      };
      if (requestDone) {
        finish();
      } else {
        // Wait for request to land
        const interval = setInterval(() => {
          if (requestDone) { clearInterval(interval); finish(); }
        }, 100);
      }
    });

    try {
      await doSubmitReply({
        seq: blockSeq,
        data: {
          handle: finalHandle,
          replyText: parsed.tweetUrl,
          // The generated type is missing these but the API Zod schema accepts them
          ...({ xPostUrl: parsed.tweetUrl, miningKeyHash: identity?.miningKeyHash } as Record<string, unknown>),
        } as any,
      });
      requestResult = "ok";
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Submission failed — try again.";

      if (status === 409) {
        // Already mined — not an error, just a friendly heads-up
        requestResult = "ok";
        toast({
          title: "Already mined ⛏️",
          description: msg,
        });
        setUrlInput("");
      } else {
        requestResult = "error";
        setErrorMsg(msg);
      }
    } finally {
      requestDone = true;
    }
  };

  const isAnimating = ["checking-key", "extracting", "submitting", "scoring"].includes(step);

  return (
    <div className="space-y-4">
      {isAnimating && <MiningProgressBar step={step} />}

      {!isAnimating && (
        <div className="border-4 border-foreground bg-card brutal-shadow p-6 space-y-5">
          <div>
            <h3 className="text-2xl font-black uppercase">
              {step === "complete" ? "⚡ Submission Mined" : "Paste Your X Post URL"}
            </h3>
            {step !== "complete" && (
              <p className="font-mono text-xs text-muted-foreground mt-1">
                Reply to @interchained's post on X, then paste your post URL here to mine ITC.
              </p>
            )}
          </div>

          {step === "complete" ? (
            <div className="text-center space-y-3 py-4">
              <div className="text-5xl">⚡</div>
              <p className="font-mono text-sm text-muted-foreground">
                Your signal is being scored. Check back to see your hashpower and AI comment.
              </p>
              <button
                onClick={() => { setStep("idle"); setUrlInput(""); }}
                className="font-mono text-xs text-muted-foreground hover:text-primary underline transition-colors"
              >
                Submit another URL
              </button>
            </div>
          ) : (
            <>
              {/* URL input — the main CTA */}
              <input
                id={`${uid}-url`}
                type="url"
                value={urlInput}
                onChange={e => { setUrlInput(e.target.value); setErrorMsg(null); }}
                onKeyDown={e => e.key === "Enter" && !isDisabled && handleSubmit()}
                placeholder="https://x.com/yourhandle/status/..."
                autoComplete="off"
                disabled={isDisabled}
                className="w-full border-4 border-foreground bg-background font-mono text-base px-4 py-3 focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
              />

              {/* First-time miner: launch onboarding modal */}
              {isFirstTime && !showOnboarding && (
                <div className="space-y-3 border-4 border-primary bg-primary/5 p-5 animate-in fade-in">
                  <div className="text-center space-y-2">
                    <div className="text-4xl">⛏️</div>
                    <div className="font-black text-lg uppercase">New Miner?</div>
                    <p className="font-mono text-xs text-muted-foreground">
                      Set up your miner identity in 30 seconds to start earning ITC.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowOnboarding(true)}
                    className="w-full border-4 border-foreground bg-primary text-primary-foreground py-3 font-black uppercase text-sm brutal-shadow hover:-translate-y-1 active:translate-y-0 transition-transform"
                  >
                    Set Up Mining Identity ⚡
                  </button>
                </div>
              )}

              {/* Onboarding Modal */}
              {identity && showOnboarding && (
                <OnboardingModal
                  open={showOnboarding}
                  identity={identity}
                  onSetHandle={(h) => { setXHandle(h); setHandleInput(h); }}
                  onSetWallet={setWalletAddress}
                  onSetEmail={setEmail}
                  onComplete={() => { completeOnboarding(); setShowOnboarding(false); }}
                />
              )}

              {/* Error */}
              {errorMsg && (
                <div className="border-2 border-destructive bg-destructive/10 px-4 py-2 font-mono text-sm text-destructive font-bold">
                  {errorMsg}
                </div>
              )}

              {/* Submit button */}
              <button
                onClick={handleSubmit}
                disabled={isDisabled || !urlInput.trim()}
                className="w-full border-4 border-foreground bg-primary text-primary-foreground py-4 font-black text-xl uppercase brutal-shadow hover:-translate-y-1 active:translate-y-0 transition-transform disabled:opacity-40 disabled:translate-y-0 disabled:cursor-not-allowed"
              >
                {buttonLabel[step]}
              </button>

              {savedHandle && (
                <div className="font-mono text-xs text-muted-foreground text-center">
                  Mining as <span className="text-foreground font-bold">@{savedHandle}</span> · Mining Key Active
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Optimistic pending card */}
      {pendingEntry && <PendingReplyCard entry={pendingEntry} />}
    </div>
  );
}

// ── Score display helpers ─────────────────────────────────────────────────────

function qualityColor(q: number) {
  if (q >= 80) return "bg-primary text-primary-foreground";
  if (q >= 60) return "bg-secondary text-secondary-foreground";
  return "bg-muted text-muted-foreground";
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BlockDetail() {
  const params = useParams();
  const seq = parseInt(params.seq || "0", 10);

  const { data: blockData, isLoading: isLoadingBlock } = useGetBlock(seq, {
    query: { enabled: !!seq, queryKey: getGetBlockQueryKey(seq) },
  });
  const { data: replies, isLoading: isLoadingReplies } = useListReplies(seq, {
    query: { enabled: !!seq, queryKey: getListRepliesQueryKey(seq) },
  });

  // Hook must be called unconditionally (Rules of Hooks)
  const block = blockData?.block;
  const closesAtForCountdown = block?.status === "open" ? block.closesAt : null;
  const countdown = useCountdown(closesAtForCountdown);

  if (isLoadingBlock)
    return <div className="p-8 text-center font-mono font-bold uppercase animate-pulse">Loading block…</div>;
  if (!blockData || !block)
    return <div className="p-8 text-center font-mono font-bold uppercase text-destructive">Block not found</div>;

  const { leaderboard } = blockData;
  const isOpen = block.status === "open";
  const isSettled = block.status === "settled" || block.status === "paid";
  const isClosed = block.status === "closed";

  // Settlement preview: show projected winners when block is closed (settling) or open with valid miners
  const totalHashpower = leaderboard?.reduce((sum, e) => sum + e.socialHashpower, 0) ?? 0;

  return (
    <div className="space-y-10 animate-in fade-in">

      {/* ── Block header ── */}
      <div className="border-4 border-foreground p-8 bg-card brutal-shadow space-y-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -z-10 translate-x-1/2 -translate-y-1/2" />

        <div className="flex items-center gap-3 font-mono font-bold uppercase flex-wrap">
          <span className="bg-foreground text-background px-3 py-1 text-lg brutal-shadow">#{block.seq}</span>
          <span className={`border-2 px-3 py-1 text-base ${
            isOpen
              ? "border-primary text-primary bg-primary/10 animate-pulse"
              : "border-muted-foreground/50 text-muted-foreground"
          }`}>
            {isOpen ? "🟢 OPEN" : block.status.toUpperCase()}
          </span>
          {block.validCount > 0 && (
            <span className="border border-foreground/20 px-3 py-1 text-sm text-muted-foreground">
              {block.validCount} valid · {replies?.length ?? 0} submitted
            </span>
          )}
        </div>

        <h1 className="text-4xl md:text-6xl font-black uppercase leading-none tracking-tighter">
          {block.title}
        </h1>
        <p className="text-xl md:text-2xl border-l-8 border-primary pl-6 py-2 font-medium">
          {block.topic}
        </p>

        <div className="flex flex-wrap gap-4">
          <div className="bg-secondary text-secondary-foreground px-6 py-3 font-mono font-bold border-4 border-foreground brutal-shadow text-lg">
            {formatItc(block.rewardItc)} ITC Pool
          </div>
          {/* Live countdown */}
          {isOpen && countdown && (
            <div className="bg-destructive/10 text-destructive px-6 py-3 font-mono font-bold border-4 border-destructive/50 brutal-shadow text-lg animate-pulse">
              ⏱ Closes in {countdown}
            </div>
          )}
          {isOpen && !countdown && block.closesAt && (
            <div className="bg-muted text-muted-foreground px-6 py-3 font-mono font-bold border-4 border-foreground/30 text-lg">
              Closing soon…
            </div>
          )}
          {isClosed && (
            <div className="bg-muted text-muted-foreground px-6 py-3 font-mono font-bold border-2 border-foreground/40 text-lg">
              ⛏ Closed — Settlement pending
            </div>
          )}
          {isSettled && (
            <Link href={`/blocks/${block.seq}/settlement`}
              className="bg-primary text-primary-foreground px-6 py-3 font-mono font-bold border-4 border-foreground brutal-shadow text-lg hover:-translate-y-1 transition-transform inline-block">
              View Settlement Proof →
            </Link>
          )}
        </div>

        {/* Step 1: Go reply on X */}
        {isOpen && (
          <div className="border-t-4 border-foreground pt-5 space-y-3">
            <div className="font-mono text-xs font-bold uppercase text-muted-foreground">
              Step 1 — Reply on X
            </div>
            {block.postContent && (
              <p className="whitespace-pre-wrap text-sm font-medium bg-muted/30 border-2 border-foreground p-4 leading-relaxed">
                {block.postContent}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              {block.xPostUrl ? (
                <a href={block.xPostUrl} target="_blank" rel="noopener noreferrer"
                  className="bg-foreground text-background px-5 py-2.5 font-mono font-bold border-4 border-foreground brutal-shadow hover:-translate-y-1 transition-transform inline-block text-sm">
                  Reply on X →
                </a>
              ) : block.shareUrl ? (
                <a href={block.shareUrl} target="_blank" rel="noopener noreferrer"
                  className="bg-foreground text-background px-5 py-2.5 font-mono font-bold border-4 border-foreground brutal-shadow hover:-translate-y-1 transition-transform inline-block text-sm">
                  Share on X →
                </a>
              ) : null}
              <a href="https://x.com/intent/follow?screen_name=interchained" target="_blank" rel="noopener noreferrer"
                className="bg-primary/10 text-primary px-5 py-2.5 font-mono font-bold border-2 border-primary/50 hover:-translate-y-1 transition-transform inline-block text-sm">
                Follow @interchained
              </a>
            </div>
          </div>
        )}
      </div>

      {/* ── Step 2: Submit form ── */}
      {isOpen && (
        <div className="space-y-1">
          <div className="font-mono text-xs font-bold uppercase text-muted-foreground px-1">
            Step 2 — Submit Your X Post URL to Mine ITC
          </div>
          <MineSubmitForm blockSeq={seq} isOpen={isOpen} />
        </div>
      )}

      {/* ── Hashpit — block-scoped live chat ── */}
      <Hashpit
        channel={`block-${block.seq}`}
        title={`Block #${block.seq} Hashpit`}
        readOnly={!isOpen}
      />

      {/* ── Settlement Preview (closed or open with miners) ── */}
      {(isClosed || (isOpen && leaderboard && leaderboard.length > 0)) && totalHashpower > 0 && (
        <div className="border-4 border-foreground bg-card brutal-shadow p-6 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-2xl font-black uppercase tracking-tighter">
                {isClosed ? "⚡ Settlement Preview" : "📊 Projected Winners"}
              </h2>
              <p className="font-mono text-xs text-muted-foreground mt-1">
                {isClosed
                  ? "Block closed — these miners are in line for settlement."
                  : "Live projection based on current hashpower. Rankings shift until close."}
              </p>
            </div>
            <div className="bg-foreground text-background px-4 py-2 font-mono text-sm font-bold">
              {leaderboard?.length ?? 0} miners · {formatItc(block.rewardItc)} ITC
            </div>
          </div>

          <div className="border-2 border-foreground">
            <div className="grid grid-cols-12 gap-1 bg-muted/50 p-2 font-mono text-[10px] font-bold uppercase">
              <div className="col-span-1">#</div>
              <div className="col-span-3">Miner</div>
              <div className="col-span-2 text-right">Hashpower</div>
              <div className="col-span-2 text-right">Share</div>
              <div className="col-span-2 text-right">Est. ITC</div>
              <div className="col-span-2 text-right">Quality</div>
            </div>
            {leaderboard?.slice(0, 10).map((entry, idx) => {
              const share = totalHashpower > 0 ? entry.socialHashpower / totalHashpower : 0;
              const estItc = share * block.rewardItc;
              return (
                <div key={entry.handle} className={`grid grid-cols-12 gap-1 p-2 font-mono text-xs border-t border-foreground/20 ${idx < 3 ? "bg-primary/5" : ""}`}>
                  <div className="col-span-1 font-bold">
                    {idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : idx + 1}
                  </div>
                  <div className="col-span-3">
                    <Link href={`/participants/${entry.handle}`} className="font-bold hover:text-primary transition-colors">
                      @{entry.handle}
                    </Link>
                    {entry.verified && <span className="ml-1 text-blue-400">✓</span>}
                  </div>
                  <div className="col-span-2 text-right font-bold">{entry.socialHashpower.toFixed(0)}</div>
                  <div className="col-span-2 text-right text-muted-foreground">{(share * 100).toFixed(1)}%</div>
                  <div className="col-span-2 text-right font-bold text-primary">{formatItc(estItc)}</div>
                  <div className="col-span-2 text-right text-muted-foreground">{entry.qualityScore.toFixed(0)}</div>
                </div>
              );
            })}
            {leaderboard && leaderboard.length > 10 && (
              <div className="p-2 text-center font-mono text-xs text-muted-foreground border-t border-foreground/20">
                +{leaderboard.length - 10} more miners
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Leaderboard + Signal feed ── */}
      <div className="grid lg:grid-cols-3 gap-8">

        {/* Leaderboard */}
        <div className="lg:col-span-1 space-y-4">
          <h2 className="text-2xl font-black uppercase tracking-tighter border-b-4 border-foreground pb-2">
            Top Miners
          </h2>
          <div className="border-4 border-foreground bg-card brutal-shadow">
            {!leaderboard || leaderboard.length === 0 ? (
              <div className="p-8 text-center font-mono text-sm text-muted-foreground uppercase">
                No valid replies yet
              </div>
            ) : (
              <div className="flex flex-col divide-y-4 divide-foreground">
                {leaderboard.map((entry, idx) => (
                  <div key={entry.handle} className={`flex items-center gap-3 p-4 ${idx === 0 ? "bg-primary/10" : ""}`}>
                    <div className={`font-black text-xl w-6 text-center ${idx === 0 ? "text-primary" : "text-muted-foreground"}`}>
                      {entry.rank}
                    </div>
                    <div className="flex-1 min-w-0">
                      <Link href={`/participants/${entry.handle}`}
                        className="font-bold hover:text-primary transition-colors break-all text-sm">
                        @{entry.handle}
                      </Link>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        Q:{entry.qualityScore.toFixed(0)} · T:{entry.trustWeight.toFixed(2)}x
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-black text-primary text-sm">{formatItc(entry.estimatedItc)}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">Est. ITC</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Signal feed */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-2xl font-black uppercase tracking-tighter border-b-4 border-foreground pb-2">
            Signal Feed
            {replies && replies.length > 0 && (
              <span className="ml-2 font-mono text-sm font-normal text-muted-foreground">
                ({replies.length})
              </span>
            )}
          </h2>

          {isLoadingReplies ? (
            <div className="h-32 bg-muted animate-pulse border-4 border-foreground brutal-shadow" />
          ) : !replies || replies.length === 0 ? (
            <div className="border-4 border-foreground bg-card p-12 text-center brutal-shadow font-mono text-muted-foreground">
              No submissions yet — be the first miner
            </div>
          ) : (
            <div className="space-y-4">
              {replies.map((reply) => (
                <div key={reply.id}
                  className={`border-4 border-foreground bg-card brutal-shadow ${reply.flagged ? "border-destructive bg-destructive/5" : ""}`}>

                  <div className="p-5 space-y-3">
                    {/* Header */}
                    <div className="flex justify-between items-start gap-4 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link href={`/participants/${reply.handle}`}
                          className="font-black text-lg hover:text-primary transition-colors">
                          @{reply.handle}
                        </Link>
                        <span className={`px-2 py-0.5 text-xs font-mono font-bold uppercase border-2 border-foreground ${
                          reply.status === "valid" || reply.status === "settled"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}>
                          {reply.status === "valid" || reply.status === "settled" ? "✓ Valid" : reply.status}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground shrink-0">
                        {new Date(reply.createdAt).toLocaleTimeString()}
                      </span>
                    </div>

                    {/* Text */}
                    <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap">
                      {reply.replyText}
                    </p>

                    {/* Plain-English verdict */}
                    {reply.aiScores?.rationale && (
                      <p className="font-mono text-xs text-muted-foreground italic border-l-2 border-foreground/20 pl-3">
                        "{reply.aiScores.rationale}"
                      </p>
                    )}

                    {/* Hashpower bar */}
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-muted border border-foreground/20 overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all duration-700"
                            style={{ width: `${Math.min(100, reply.socialHashpower).toFixed(1)}%` }}
                          />
                        </div>
                        <span className={`font-mono text-xs font-bold px-2 py-0.5 border border-foreground ${qualityColor(reply.qualityScore)}`}>
                          HP {reply.socialHashpower.toFixed(0)}
                        </span>
                      </div>

                      {/* Score grid */}
                      <div className="grid grid-cols-4 gap-1.5 font-mono text-[10px]">
                        {[
                          { label: "Quality", value: reply.qualityScore.toFixed(0) },
                          { label: "Trust",   value: `${reply.trustWeight.toFixed(2)}x` },
                          { label: "Unique",  value: reply.uniqueness.toFixed(2) },
                          { label: "Reach",   value: reply.reachFactor.toFixed(2) },
                        ].map(({ label, value }) => (
                          <div key={label} className="border border-foreground/20 px-1 py-0.5 text-center bg-muted/20">
                            <div className="text-muted-foreground">{label}</div>
                            <div className="font-bold text-foreground">{value}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {reply.status !== "valid" && reply.status !== "settled" && reply.rejectionReason && (
                      <div className="text-xs font-mono text-destructive font-bold border-l-4 border-destructive pl-3 py-1">
                        {reply.rejectionReason}
                      </div>
                    )}
                  </div>

                  {/* AI comment */}
                  {reply.aiReplyText && (
                    <div className="border-t-2 border-foreground/20 bg-primary/5 px-5 py-4 flex gap-3 items-start">
                      <div className="shrink-0 mt-0.5 w-7 h-7 bg-foreground text-background flex items-center justify-center font-black text-[10px] border-2 border-foreground">
                        AI
                      </div>
                      <div>
                        <div className="font-mono text-[10px] font-bold uppercase text-muted-foreground mb-0.5">
                          Kudos AI · in response
                        </div>
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
    </div>
  );
}
