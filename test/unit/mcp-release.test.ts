import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditMcpPackageFiles, checkMcpReleaseCandidate, sanitizeCommandOutput } from "../../scripts/check-mcp-release-candidate.mjs";
import { isReleaseWatchIssue } from "../../scripts/check-mcp-release-due.mjs";
import { buildMcpReleaseIssue, buildMcpReleaseReport, renderMcpChangelog, selectMcpReleaseCommits } from "../../scripts/mcp-release-core.mjs";

type TestCommit = {
  sha: string;
  subject: string;
  files: string[];
};

function commit(subject: string, files: string[], sha = subject): TestCommit {
  return { sha: sha.padEnd(40, "0").slice(0, 40), subject, files };
}

describe("MCP release changelog detection", () => {
  it("includes package-only MCP package changes", () => {
    const commits = selectMcpReleaseCommits([commit("docs(ci): add MCP package usage note (#1)", ["packages/gittensory-mcp/README.md"])]);

    expect(commits.map((entry) => entry.subject)).toEqual(["docs(ci): add MCP package usage note (#1)"]);
  });

  it("includes MCP server tool changes", () => {
    const commits = selectMcpReleaseCommits([commit("feat(mcp): add branch eligibility tool (#2)", ["src/mcp/server.ts"])]);

    expect(commits.map((entry) => entry.subject)).toEqual(["feat(mcp): add branch eligibility tool (#2)"]);
  });

  it("includes compatibility metadata changes", () => {
    const commits = selectMcpReleaseCommits([commit("feat(analytics): track MCP compatibility adoption (#3)", ["src/services/mcp-compatibility.ts"])]);

    expect(commits.map((entry) => entry.subject)).toEqual(["feat(analytics): track MCP compatibility adoption (#3)"]);
  });

  it("excludes UI-only changes", () => {
    const commits = selectMcpReleaseCommits([
      commit("feat(ui): add release dashboard card (#4)", ["apps/gittensory-ui/src/routes/app.operator.tsx", "apps/gittensory-ui/public/openapi.json"]),
    ]);

    expect(commits).toEqual([]);
  });

  it("excludes test-only support changes even when they touch local signal helpers", () => {
    const commits = selectMcpReleaseCommits([commit("test(coverage): raise website closeout gates (#5)", ["src/signals/local-branch.ts", "test/unit/local-branch.test.ts"])]);

    expect(commits).toEqual([]);
  });

  it("preserves previous release sections byte-for-byte", () => {
    const priorSections = `## mcp-v0.3.0 - 2026-05-31

### Features
- Existing feature text

## mcp-v0.2.0 - 2026-05-29

### Fixes
- Existing fix text
`;
    const changelog = renderMcpChangelog({
      existingChangelog: `# Changelog\n\n${priorSections}`,
      targetVersion: "0.4.0",
      generatedAt: "2026-06-02",
      commits: [commit("feat(mcp): add local workspace intelligence v2 (#70)", ["packages/gittensory-mcp/bin/gittensory-mcp.js"])],
    });

    expect(changelog).toContain("## mcp-v0.4.0 - 2026-06-02");
    expect(changelog.slice(changelog.indexOf("## mcp-v0.3.0"))).toBe(priorSections);
  });

  it("builds a release-due issue with the version and checklist", () => {
    const report = buildMcpReleaseReport({
      latestTag: { tag: "mcp-v0.3.0", version: "0.3.0" },
      packageVersion: "0.4.0",
      publishedVersion: "0.3.0",
      commits: [commit("feat(mcp): add local workspace intelligence v2 (#70)", ["src/mcp/server.ts"])],
    });
    const issue = buildMcpReleaseIssue(report);

    expect(report).toMatchObject({ due: true, proposedVersion: "0.4.0", releaseType: "minor" });
    expect(issue.title).toBe("MCP release due: 0.4.0");
    expect(issue.body).toContain("<!-- gittensory:mcp-release-due -->");
    expect(issue.body).toContain("- [ ] Run `npm run test:release:mcp`");
    expect(issue.body).toContain("- [ ] Run `npm run mcp:release-candidate -- --tag mcp-v0.4.0 --full-ci`");
    expect(issue.body).toContain("- [ ] Tag `mcp-v0.4.0`");
  });

  it("escapes untrusted commit subjects in the release-due issue", () => {
    const maliciousSubject = "feat(mcp): notify @octocat [SECURITY ACTION REQUIRED](https://evil.example/phish) #123";
    const report = buildMcpReleaseReport({
      latestTag: { tag: "mcp-v0.3.0", version: "0.3.0" },
      packageVersion: "0.4.0",
      publishedVersion: "0.3.0",
      commits: [commit(maliciousSubject, ["src/mcp/server.ts"])],
    });
    const issue = buildMcpReleaseIssue(report);

    expect(issue.body).not.toContain(maliciousSubject);
    expect(issue.body).toContain("@\u200boctocat");
    expect(issue.body).toContain("\\[SECURITY ACTION REQUIRED\\]\\(https://evil\\.example/phish\\)");
    expect(issue.body).toContain("\\#123");
  });

  it("only updates the bot-owned release reminder issue", () => {
    expect(
      isReleaseWatchIssue({
        title: "MCP release due: 0.4.0",
        body: "<!-- gittensory:mcp-release-due -->",
        user: { login: "github-actions[bot]" },
      }),
    ).toBe(true);

    expect(
      isReleaseWatchIssue({
        title: "MCP release due: 0.4.0",
        body: "<!-- gittensory:mcp-release-due -->",
        user: { login: "public-contributor" },
      }),
    ).toBe(false);
  });
});

describe("MCP release candidate dry run", () => {
  it("accepts a matching package, CLI version, changelog, and tokenless publish workflow", () => {
    const root = releaseCandidateFixture();
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.5.0" });

      expect(report.ok).toBe(true);
      expect(report.checks.map((check) => check.name)).toEqual([
        "release_tag",
        "package_version",
        "cli_version",
        "compatibility_metadata",
        "changelog_section",
        "trusted_publishing",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the MCP package version as the default intended tag", () => {
    const root = releaseCandidateFixture();
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root });

      expect(report.ok).toBe(true);
      expect(report.tag).toBe("mcp-v0.5.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails malformed release tags before accepting a release candidate", () => {
    const root = releaseCandidateFixture();
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "v0.5.0" });

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "release_tag", status: "fail" })]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the intended tag does not match the package version", () => {
    const root = releaseCandidateFixture();
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.6.0" });

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "package_version", status: "fail" })]));
      expect(report.checks.find((check) => check.name === "package_version")?.detail).toContain("does not match intended tag");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the CLI packageVersion is stale", () => {
    const root = releaseCandidateFixture({ cli: 'const packageVersion = "0.4.0";\n' });
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.5.0" });

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cli_version", status: "fail" })]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when compatibility metadata does not point at the package version", () => {
    const root = releaseCandidateFixture({
      compatibility: 'export const MINIMUM_SUPPORTED_MCP_VERSION = "0.4.0";\nexport const LATEST_RECOMMENDED_MCP_VERSION = "0.5.0";\n',
    });
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.5.0" });

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "compatibility_metadata", status: "fail" })]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the target changelog section is missing", () => {
    const root = releaseCandidateFixture({
      changelog: `# Changelog

## mcp-v0.4.0 - 2026-06-02

### Fixes
- Previous release
`,
    });
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.5.0" });

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "changelog_section", status: "fail" })]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the target changelog section has no release entries", () => {
    const root = releaseCandidateFixture({
      changelog: `# Changelog

## mcp-v0.5.0 - 2026-06-04

### Chores
`,
    });
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.5.0" });

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "changelog_section", status: "fail" })]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails package audit when the tarball contains an unexpected file", () => {
    const checks = auditMcpPackageFiles(["package/package.json", "package/bin/gittensory-mcp.js", "package/private-secret.txt"], () => "placeholder");

    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "package_file:private-secret.txt", status: "fail" })]));
  });

  it("fails package audit when an allowed file contains secret-like content", () => {
    const checks = auditMcpPackageFiles(["package/package.json"], () => "API_TOKEN=not-for-public-output");

    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "package_file:package.json", status: "fail" })]));
  });

  it("fails trusted publishing validation when npm tokens are configured", () => {
    const root = releaseCandidateFixture({
      workflow: `name: Publish MCP Package
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Publish with npm trusted publishing
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
        run: npm publish --workspace @jsonbored/gittensory-mcp --provenance
`,
    });
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.5.0" });

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "trusted_publishing", status: "fail" })]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps public release-candidate output away from sensitive scoring language", () => {
    const root = releaseCandidateFixture();
    try {
      const report = checkMcpReleaseCandidate({ rootDir: root, tag: "mcp-v0.5.0" });
      const publicOutput = report.checks.map((check) => `${check.name}: ${check.detail}`).join("\n");

      expect(publicOutput).not.toMatch(/wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts local paths and token-shaped values from command output", () => {
    const sanitized = sanitizeCommandOutput("/tmp/rc/private ghp_exampletoken API_TOKEN=secret", ["/tmp/rc"]);

    expect(sanitized).toContain("<local-path>");
    expect(sanitized).not.toContain("/tmp/rc");
    expect(sanitized).not.toContain("ghp_exampletoken");
    expect(sanitized).not.toContain("API_TOKEN=secret");
  });

  it("keeps the release-candidate workflow dry-run only", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/mcp-release-candidate.yml"), "utf8");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("npm run mcp:release-candidate");
    expect(workflow).not.toMatch(/\bnpm\s+publish\b/);
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  });
});

function releaseCandidateFixture(overrides: { changelog?: string; cli?: string; compatibility?: string; workflow?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gittensory-release-candidate-"));
  writeFixture(root, "packages/gittensory-mcp/package.json", JSON.stringify({ name: "@jsonbored/gittensory-mcp", version: "0.5.0" }, null, 2));
  writeFixture(root, "packages/gittensory-mcp/bin/gittensory-mcp.js", overrides.cli ?? 'const packageVersion = "0.5.0";\n');
  writeFixture(
    root,
    "src/services/mcp-compatibility.ts",
    overrides.compatibility ??
      'export const MINIMUM_SUPPORTED_MCP_VERSION = "0.5.0";\nexport const LATEST_RECOMMENDED_MCP_VERSION = "0.5.0";\n',
  );
  writeFixture(
    root,
    "packages/gittensory-mcp/CHANGELOG.md",
    overrides.changelog ??
      `# Changelog

## mcp-v0.5.0 - 2026-06-04

### Chores
- Prepare MCP release metadata
`,
  );
  writeFixture(
    root,
    ".github/workflows/npm-publish.yml",
    overrides.workflow ??
      `name: Publish MCP Package
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Publish with npm trusted publishing
        run: npm publish --workspace @jsonbored/gittensory-mcp --access public --provenance
`,
  );
  return root;
}

function writeFixture(root: string, path: string, contents: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
