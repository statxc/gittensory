import { matchCodeowners, type CodeownersRule } from "../github/codeowners";
import type { PullRequestRecord } from "../types";
import type { BurdenForecast } from "./engine";

export const REVIEWER_BUSY_OPEN_PR_THRESHOLD = 3;
export const MAX_REVIEWER_SUGGESTIONS = 5;

export type ReviewerLoadBand = "light" | "busy";

export type ReviewerSuggestion = {
  login: string;
  matchedFileCount: number;
  loadBand: ReviewerLoadBand;
  reason: string;
};

export type ReviewerRouting = {
  suggestions: ReviewerSuggestion[];
  teams: string[];
  repoLoadLevel: BurdenForecast["level"] | null;
  summary: string;
};

export type ReviewerRoutingInput = {
  rules: CodeownersRule[];
  changedPaths: string[];
  openPullRequests: PullRequestRecord[];
  authorLogin?: string | null | undefined;
  burdenForecast?: BurdenForecast | null | undefined;
};

function stripLeadingAt(owner: string): string {
  return owner.startsWith("@") ? owner.slice(1) : owner;
}

function isTeamOwner(owner: string): boolean {
  if (!owner.startsWith("@")) return false;
  return stripLeadingAt(owner).includes("/");
}

function isUserOwner(owner: string): boolean {
  return owner.startsWith("@") && !stripLeadingAt(owner).includes("/");
}

export function buildReviewerRouting(input: ReviewerRoutingInput): ReviewerRouting {
  const authorLogin = input.authorLogin ? stripLeadingAt(input.authorLogin).toLowerCase() : null;
  const matchedReviewersByKey = new Map<string, { login: string; matchedFileCount: number }>();
  const teamSet = new Set<string>();

  for (const path of input.changedPaths) {
    const owners = matchCodeowners(input.rules, path);
    const seenForPath = new Set<string>();
    for (const owner of owners) {
      if (isTeamOwner(owner)) {
        teamSet.add(stripLeadingAt(owner));
        continue;
      }
      if (!isUserOwner(owner)) continue;
      const login = stripLeadingAt(owner);
      const key = login.toLowerCase();
      if (key === authorLogin || seenForPath.has(key)) continue;
      seenForPath.add(key);
      const existing = matchedReviewersByKey.get(key);
      if (existing) {
        existing.matchedFileCount += 1;
      } else {
        matchedReviewersByKey.set(key, { login, matchedFileCount: 1 });
      }
    }
  }

  const openPrCountByLogin = new Map<string, number>();
  for (const pr of input.openPullRequests) {
    if (pr.state !== "open") continue;
    const login = pr.authorLogin ? stripLeadingAt(pr.authorLogin).toLowerCase() : null;
    if (!login) continue;
    openPrCountByLogin.set(login, (openPrCountByLogin.get(login) ?? 0) + 1);
  }

  const suggestions: ReviewerSuggestion[] = Array.from(matchedReviewersByKey.entries()).map(([key, reviewer]) => {
    const openPrCount = openPrCountByLogin.get(key) ?? 0;
    const loadBand: ReviewerLoadBand = openPrCount >= REVIEWER_BUSY_OPEN_PR_THRESHOLD ? "busy" : "light";
    const fileWord = reviewer.matchedFileCount === 1 ? "file" : "files";
    const reason =
      loadBand === "busy"
        ? `Owns ${reviewer.matchedFileCount} changed ${fileWord}; currently has several open PRs.`
        : `Owns ${reviewer.matchedFileCount} changed ${fileWord}.`;
    return { login: reviewer.login, matchedFileCount: reviewer.matchedFileCount, loadBand, reason };
  });

  suggestions.sort((a, b) => {
    if (b.matchedFileCount !== a.matchedFileCount) return b.matchedFileCount - a.matchedFileCount;
    if (a.loadBand !== b.loadBand) return a.loadBand === "light" ? -1 : 1;
    return a.login.localeCompare(b.login);
  });

  const capped = suggestions.slice(0, MAX_REVIEWER_SUGGESTIONS);
  const teams = Array.from(teamSet).sort((a, b) => a.localeCompare(b));
  const repoLoadLevel = input.burdenForecast?.level ?? null;
  const summary =
    capped.length === 0 && teams.length === 0
      ? "No CODEOWNERS reviewers matched the changed files."
      : capped.length > 0
        ? `Suggested ${capped.length} reviewer${capped.length === 1 ? "" : "s"} from CODEOWNERS for the changed files.`
        : `Matched ${teams.length} CODEOWNERS team${teams.length === 1 ? "" : "s"} for the changed files.`;

  return { suggestions: capped, teams, repoLoadLevel, summary };
}
