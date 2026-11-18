import type {
  BuddyProjection,
  BuddyQuality,
  EnginePick,
  JobKind,
  JobProfile,
  PermissionMode,
  ProviderDiscovery,
  ProviderKind,
  TaskProjection,
} from "@zli-v2/contracts";

/**
 * Auto: picks the agent, model, effort and permission for a job, with a one-line reason. Pure, so
 * every step can be tested with fixtures; the job runner calls it before starting a job.
 */

const KIND_WORDS: ReadonlyArray<[JobKind, RegExp]> = [
  ["review", /\b(review|look over|check (the|my) (pr|diff|change))/iu],
  ["tests", /\b(tests?|spec|coverage|flaky)\b/iu],
  ["docs", /\b(docs?|readme|changelog|release notes|document)\b/iu],
  ["bugfix", /\b(fix|bug|broken|crash|error|fails?|failing|regression)\b/iu],
  ["refactor", /\b(refactor|clean ?up|rename|split|extract|simplify|migrate)\b/iu],
  ["ui", /\b(ui|page|screen|button|layout|css|style|design|component|modal|dialog)\b/iu],
  ["question", /^(what|why|how|where|which|who|is|are|does|can|should)\b.*\?$/iu],
  ["chore", /\b(bump|upgrade|update deps?|dependency|lint|format|ci)\b/iu],
];

const RISKY =
  /\b(auth|login|password|token|secret|payment|billing|migration|schema|database|security|ci config|deploy)\b/iu;
const BIG = /\b(all|every|whole|entire|across|rewrite|redesign|overhaul)\b/iu;
const SMALL = /\b(typo|small|tiny|one[- ]line|quick|rename)\b/iu;

/** Reads what kind of job this is from the goal, the skill and where it came from. */
export function profileJob(input: {
  goal: string;
  skill?: string | undefined;
  kind?: "job" | "review" | undefined;
  origin?: TaskProjection["origin"]["kind"] | undefined;
}): JobProfile {
  const text = `${input.skill ?? ""} ${input.goal}`;
  let kind: JobKind = "feature";
  if (input.kind === "review") kind = "review";
  else if (/write-tests|\btests?\b/iu.test(input.skill ?? "")) kind = "tests";
  else
    for (const [candidate, pattern] of KIND_WORDS)
      if (pattern.test(text)) {
        kind = candidate;
        break;
      }
  const files = (input.goal.match(/[\w./-]+\.[a-z]{1,5}\b/giu) ?? []).length;
  const size: JobProfile["size"] =
    BIG.test(text) || files > 8 || input.goal.length > 1_200
      ? "l"
      : SMALL.test(text) || kind === "question" || (files > 0 && files <= 2 && input.goal.length < 200)
        ? "s"
        : "m";
  const risk: JobProfile["risk"] = RISKY.test(text) || size === "l" ? "high" : "low";
  return { kind, size, risk, needsBrowser: kind === "ui" };
}

/** 1 small and fast, 2 strong all-round, 3 the most capable. Models the table does not know count as 2. */
export function modelTier(model: string | undefined): 1 | 2 | 3 {
  const id = (model ?? "").toLowerCase();
  if (/haiku|mini|nano|flash|lite|small|fast/u.test(id)) return 1;
  if (/opus|fable|\bo3\b|o1|ultra|max|\bpro\b|-pro|gpt-5(?!.*mini)|codex-max|xhigh/u.test(id)) return 3;
  return 2;
}

function neededTier(profile: JobProfile): number {
  let need = profile.size === "l" ? 3 : profile.size === "m" ? 2 : 1;
  if (profile.risk === "high") need = Math.max(need, 3);
  if (profile.kind === "docs" || profile.kind === "question" || profile.kind === "chore") need -= 1;
  if (profile.kind === "review" && profile.risk === "low") need = Math.min(need, 2);
  return Math.min(3, Math.max(1, need));
}

const COST_BY_TIER = { 1: 0.15, 2: 0.45, 3: 1 } as const;

export type Candidate = { provider: ProviderKind; model?: string | undefined; efforts?: readonly string[] | undefined };

/** Every agent ZLI found and can run, with its models, narrowed to what the buddy allows. */
export function candidatesFor(
  providers: readonly ProviderDiscovery[],
  buddy: Pick<BuddyProjection, "engine">,
  override?: TaskProjection["override"],
): Candidate[] {
  const usable = providers.filter(
    (provider): provider is Extract<ProviderDiscovery, { status: "found" }> =>
      provider.status === "found" && provider.login?.status !== "signed-out" && provider.problem === undefined,
  );
  const allowed = override
    ? usable.filter((provider) => provider.provider === override.provider)
    : buddy.engine.mode === "auto"
      ? usable
      : usable.filter((provider) => provider.provider === (buddy.engine as { provider: ProviderKind }).provider);
  const out: Candidate[] = [];
  for (const provider of allowed) {
    const wantModel = override?.model ?? (buddy.engine.mode === "locked" ? buddy.engine.model : undefined);
    const models = (provider.models ?? []).filter((model) => !wantModel || model.id === wantModel);
    if (models.length === 0) {
      out.push({
        provider: provider.provider,
        ...(wantModel ? { model: wantModel } : {}),
        efforts: provider.reasoningEfforts,
      });
      continue;
    }
    for (const model of models.slice(0, 12))
      out.push({
        provider: provider.provider,
        model: model.id,
        efforts: model.reasoningEfforts ?? provider.reasoningEfforts,
      });
  }
  return out;
}

export type TrackRecord = { jobs: number; score: number; costUsd: number };

/** How well each provider and model did on each kind of job, from finished jobs. Local only. */
export function trackRecords(tasks: readonly TaskProjection[]): Map<string, TrackRecord> {
  const records = new Map<string, { jobs: number; total: number; costUsd: number }>();
  const add = (pick: EnginePick, kind: JobKind, points: number, costUsd = 0) => {
    const key = recordKey(pick.provider, pick.model, kind);
    const entry = records.get(key) ?? { jobs: 0, total: 0, costUsd: 0 };
    entry.jobs += 1;
    entry.total += points;
    entry.costUsd += costUsd;
    records.set(key, entry);
  };
  for (const task of tasks) {
    if (!task.pick || !task.profile) continue;
    // A model the job stepped up or switched away from failed it.
    for (const earlier of task.picks) add(earlier, task.profile.kind, -1);
    let points: number;
    if (task.undone) points = -1;
    else if (task.status === "failed") points = -1;
    else if (task.status === "ready" || task.status === "shipped" || task.status === "closed")
      points = 1 - 0.2 * task.revisions.length + (task.status === "shipped" ? 0.5 : 0);
    else continue;
    add(task.pick, task.profile.kind, points, task.result?.costUsd ?? 0);
  }
  const out = new Map<string, TrackRecord>();
  for (const [key, entry] of records)
    out.set(key, {
      jobs: entry.jobs,
      // -1..1.5 per job, mapped to 0..1.
      score: Math.min(1, Math.max(0, (entry.total / entry.jobs + 1) / 2.5)),
      costUsd: entry.costUsd / entry.jobs,
    });
  return out;
}

export function recordKey(provider: string, model: string | undefined, kind: JobKind): string {
  return `${provider}|${model ?? ""}|${kind}`;
}

export type PickInput = {
  buddy: Pick<BuddyProjection, "engine" | "permissionMode">;
  profile: JobProfile;
  candidates: readonly Candidate[];
  records: ReadonlyMap<string, TrackRecord>;
  quality: BuddyQuality;
  /** Highest share of any plan-limit window used, 0–100, by provider. */
  used?: ReadonlyMap<string, number>;
  /** The provider the buddy ran last, which wins ties so buddies feel consistent. */
  lastProvider?: string | undefined;
  /** Providers the person chose by hand for this kind of job before. */
  preferred?: ReadonlySet<string>;
  /** Leave these out: a step-up or a switch away from a limit. */
  exclude?: (candidate: Candidate) => boolean;
  /** Only candidates above this tier: a step-up. */
  minTier?: number;
  override?: boolean;
  now: string;
};

export type Scored = { candidate: Candidate; score: number; tier: number; factors: string[] };

export function scoreCandidates(input: PickInput): Scored[] {
  const need = neededTier(input.profile);
  const costWeight = input.quality === "save" ? 0.35 : input.quality === "best" ? 0.05 : 0.18;
  const scored: Scored[] = [];
  for (const candidate of input.candidates) {
    if (input.exclude?.(candidate)) continue;
    const tier = modelTier(candidate.model);
    if (input.minTier !== undefined && tier <= input.minTier) continue;
    const used = input.used?.get(candidate.provider) ?? 0;
    if (used >= 95) continue;
    const factors: string[] = [];
    let fit = tier >= need ? 1 - 0.12 * (tier - need) : 1 - 0.4 * (need - tier);
    if (input.quality === "best") fit += 0.1 * (tier - 2);
    const record = input.records.get(recordKey(candidate.provider, candidate.model, input.profile.kind));
    let score = fit;
    if (record) {
      const weight = record.jobs / (record.jobs + 5);
      score = fit * (1 - weight) + record.score * weight;
      if (weight >= 0.5) factors.push(record.score >= 0.6 ? "good record on these jobs" : "weak record on these jobs");
    }
    score -= costWeight * COST_BY_TIER[tier];
    if (used >= 80) {
      score *= 0.1;
      factors.push(`${Math.round(used)}% of its limit used`);
    }
    if (input.preferred?.has(candidate.provider)) score += 0.05;
    if (input.lastProvider === candidate.provider) score += 0.001;
    scored.push({ candidate, score, tier, factors });
  }
  return scored.sort((left, right) => right.score - left.score);
}

const KIND_LABEL: Record<JobKind, string> = {
  bugfix: "bug fix",
  feature: "feature",
  refactor: "refactor",
  tests: "tests",
  docs: "docs",
  ui: "UI change",
  review: "review",
  question: "question",
  chore: "chore",
  web: "web job",
  plan: "planning turn",
};
const SIZE_LABEL = { s: "small", m: "medium", l: "big" } as const;

function effortFor(profile: JobProfile, efforts: readonly string[] | undefined): string | undefined {
  if (!efforts || efforts.length === 0) return undefined;
  const want =
    profile.size === "l" || profile.risk === "high"
      ? ["high", "xhigh"]
      : profile.size === "s"
        ? ["low", "minimal"]
        : ["medium"];
  return want.find((effort) => efforts.includes(effort));
}

/** The permission a job runs with: never above the buddy's, read-only for reviews and questions. */
export function permissionFor(profile: JobProfile, ceiling: PermissionMode): PermissionMode {
  // A lead plans and hands out work with ZLI's tools; it never changes files.
  if (profile.kind === "review" || profile.kind === "question" || profile.kind === "plan") return "read-only";
  return ceiling;
}

export function displayModel(candidate: Candidate): string {
  return candidate.model ?? candidate.provider;
}

/** The setup for a job, or undefined when no agent can run it. */
export function pickEngine(input: PickInput): EnginePick | undefined {
  const [best, second] = scoreCandidates(input);
  if (!best) return undefined;
  const { candidate } = best;
  const source: EnginePick["source"] = input.override
    ? "you"
    : input.buddy.engine.mode === "auto"
      ? "auto"
      : input.buddy.engine.mode;
  const effort =
    input.buddy.engine.mode === "locked" && input.buddy.engine.effort
      ? input.buddy.engine.effort
      : effortFor(input.profile, candidate.efforts);
  const what = `${SIZE_LABEL[input.profile.size]} ${KIND_LABEL[input.profile.kind]}${input.profile.risk === "high" ? ", risky" : ""}`;
  const why =
    source === "you"
      ? "you picked it"
      : source === "locked"
        ? "this buddy always uses it"
        : (best.factors[0] ??
          (second && second.tier > best.tier
            ? `${displayModel(candidate)} is enough and costs less`
            : best.tier === 3
              ? `${displayModel(candidate)} for the hard parts`
              : `${displayModel(candidate)} fits`));
  return {
    provider: candidate.provider,
    ...(candidate.model ? { model: candidate.model } : {}),
    ...(effort ? { effort } : {}),
    permissionMode: permissionFor(input.profile, input.buddy.permissionMode),
    reason: `${what[0]?.toUpperCase()}${what.slice(1)}; ${why}`.slice(0, 300),
    source,
    at: input.now,
  };
}
