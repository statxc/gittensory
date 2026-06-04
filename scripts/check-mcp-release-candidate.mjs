#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageJsonPath = "packages/gittensory-mcp/package.json";
const cliPath = "packages/gittensory-mcp/bin/gittensory-mcp.js";
const compatibilityPath = "src/services/mcp-compatibility.ts";
const changelogPath = "packages/gittensory-mcp/CHANGELOG.md";
const publishWorkflowPath = ".github/workflows/npm-publish.yml";
const allowedPackageFiles = [/^bin\/gittensory-mcp\.js$/, /^lib\/local-branch\.js$/, /^scripts\/gittensor-score-preview\.(mjs|py)$/, /^package\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/];
const forbiddenPackagePath = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;
const forbiddenPackageContent = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=)/;
const npmTokenWorkflowPattern = /(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_[A-Z0-9_]*TOKEN|\/\/registry\.npmjs\.org\/:_authToken|npmrc|secrets\.(?:NPM|NODE_AUTH)[A-Z0-9_]*)/i;
const stableMcpTagPattern = /^mcp-v(\d+\.\d+\.\d+)$/;

export function checkMcpReleaseCandidate(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const packageJson = readJson(rootDir, options.packageJsonPath ?? packageJsonPath);
  const version = packageJson.version;
  const tag = options.tag ?? process.env.REF_NAME ?? process.env.GITHUB_REF_NAME ?? (version ? `mcp-v${version}` : "");
  const checks = [];

  addCheck(checks, "release_tag", () => {
    const match = stableMcpTagPattern.exec(tag);
    if (!match) throw new Error(`Release tag must match mcp-vX.Y.Z, got ${tag || "(missing)"}.`);
    return `Tag ${tag} is well formed.`;
  });

  addCheck(checks, "package_version", () => {
    const tagVersion = versionFromMcpTag(tag);
    if (!version) throw new Error(`${packageJsonPath} does not declare a version.`);
    if (version !== tagVersion) throw new Error(`${packageJsonPath} version ${version} does not match intended tag ${tag}.`);
    return `Package version ${version} matches ${tag}.`;
  });

  addCheck(checks, "cli_version", () => {
    const cliText = readText(rootDir, cliPath);
    const cliVersion = readStringConstant(cliText, "packageVersion");
    if (cliVersion !== version) throw new Error(`${cliPath} packageVersion ${cliVersion ?? "(missing)"} does not match ${version}.`);
    return `CLI packageVersion matches ${version}.`;
  });

  addCheck(checks, "compatibility_metadata", () => {
    const compatibilityText = readText(rootDir, compatibilityPath);
    const minimum = readStringConstant(compatibilityText, "MINIMUM_SUPPORTED_MCP_VERSION");
    const latest = readStringConstant(compatibilityText, "LATEST_RECOMMENDED_MCP_VERSION");
    if (minimum !== version) throw new Error(`${compatibilityPath} MINIMUM_SUPPORTED_MCP_VERSION ${minimum ?? "(missing)"} does not match ${version}.`);
    if (latest !== version) throw new Error(`${compatibilityPath} LATEST_RECOMMENDED_MCP_VERSION ${latest ?? "(missing)"} does not match ${version}.`);
    return `MCP compatibility metadata points at ${version}.`;
  });

  addCheck(checks, "changelog_section", () => {
    const changelog = readText(rootDir, changelogPath);
    const section = findMcpChangelogSection(changelog, version);
    if (!section) throw new Error(`${changelogPath} is missing a mcp-v${version} release section.`);
    if (!/^\s*-\s+\S/m.test(section.body)) throw new Error(`${changelogPath} mcp-v${version} section has no release entries.`);
    return `Changelog contains mcp-v${version}.`;
  });

  addCheck(checks, "trusted_publishing", () => {
    const workflow = readText(rootDir, publishWorkflowPath);
    if (!/^\s*id-token:\s*write\s*$/m.test(workflow)) throw new Error(`${publishWorkflowPath} must grant id-token: write for npm trusted publishing.`);
    if (!/npm[^\n]*publish[^\n]*--provenance/m.test(workflow)) throw new Error(`${publishWorkflowPath} must publish with npm provenance.`);
    if (npmTokenWorkflowPattern.test(workflow)) throw new Error(`${publishWorkflowPath} must not configure npm auth tokens for trusted publishing.`);
    return "npm publish workflow is tokenless and provenance-enabled.";
  });

  return summarizeChecks({ tag, version, checks });
}

export function auditMcpPackageFiles(files, readContent = () => "") {
  const checks = [];
  for (const rawFile of files) {
    const file = normalizePackageFilePath(rawFile);
    if (!file || file.endsWith("/")) continue;
    addCheck(checks, `package_file:${file}`, () => {
      if (forbiddenPackagePath.test(file)) throw new Error(`Forbidden file in MCP package: ${file}`);
      if (!allowedPackageFiles.some((pattern) => pattern.test(file))) throw new Error(`Unexpected file in MCP package: ${file}`);
      const content = readContent(rawFile, file);
      if (typeof content === "string" && forbiddenPackageContent.test(content)) throw new Error(`Secret-like content found in MCP package file: ${file}`);
      return `${file} is allowed.`;
    });
  }
  return checks;
}

export function runMcpReleaseCandidate(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const metadataReport = checkMcpReleaseCandidate({ ...options, rootDir });
  const checks = [...metadataReport.checks];
  if (checks.some((check) => check.status === "fail")) return summarizeChecks({ tag: metadataReport.tag, version: metadataReport.version, checks });

  if (!options.metadataOnly) {
    if (options.fullCi) {
      runCheck(checks, rootDir, "release_validation_gate", ["npm", ["run", "test:release:mcp"]]);
    } else {
      runCheck(checks, rootDir, "build_mcp", ["npm", ["run", "build:mcp"]]);
      runCheck(checks, rootDir, "package_dry_run", ["npm", ["run", "test:mcp-pack"]]);
      runCheck(checks, rootDir, "changelog_check", ["npm", ["run", "changelog:check:mcp"]]);
    }
    addCheck(checks, "tarball_smoke", () => {
      runPackedTarballSmoke(rootDir);
      return "Packed MCP tarball passed allowlist, secret scan, install, and CLI smoke.";
    });
  }

  return summarizeChecks({ tag: metadataReport.tag, version: metadataReport.version, checks });
}

function runCheck(checks, rootDir, name, [command, args]) {
  addCheck(checks, name, () => {
    runCommand(command, args, rootDir);
    return `${command} ${args.join(" ")} passed.`;
  });
}

function runPackedTarballSmoke(rootDir) {
  let tarballPath;
  let tempDir;
  try {
    const packResult = runCommand("npm", ["pack", "--workspace", "@jsonbored/gittensory-mcp", "--json"], rootDir);
    const [pack] = JSON.parse(packResult.stdout);
    if (!pack?.filename) throw new Error("npm pack did not report a tarball filename.");
    tarballPath = resolve(rootDir, pack.filename);
    const entries = runCommand("tar", ["-tzf", tarballPath], rootDir, { extraRedactions: [tarballPath] }).stdout
      .split("\n")
      .filter(Boolean);
    const audit = auditMcpPackageFiles(entries, (rawFile) => runCommand("tar", ["-xOf", tarballPath, rawFile], rootDir, { extraRedactions: [tarballPath] }).stdout);
    const failure = audit.find((check) => check.status === "fail");
    if (failure) throw new Error(failure.detail);

    tempDir = mkdtempSync(join(tmpdir(), "gittensory-mcp-rc-"));
    runCommand("npm", ["--prefix", tempDir, "init", "-y"], rootDir, { quiet: true, extraRedactions: [tempDir] });
    runCommand("npm", ["--prefix", tempDir, "install", tarballPath], rootDir, { quiet: true, extraRedactions: [tempDir, tarballPath] });
    runCommand(join(tempDir, "node_modules/.bin/gittensory-mcp"), ["--help"], rootDir, { quiet: true, extraRedactions: [tempDir, tarballPath] });
  } finally {
    if (tarballPath && existsSync(tarballPath)) rmSync(tarballPath, { force: true });
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCommand(command, args, rootDir, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output = sanitizeCommandOutput(`${result.error?.message || result.stderr || result.stdout || ""}`, [rootDir, ...(options.extraRedactions ?? [])]).trim();
    throw new Error(`Command failed: ${command} ${args.join(" ")}${output ? `\n${output}` : ""}`);
  }
  return result;
}

function addCheck(checks, name, fn) {
  try {
    checks.push({ name, status: "pass", detail: fn() });
  } catch (error) {
    checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }
}

function summarizeChecks({ tag, version, checks }) {
  return {
    ok: checks.every((check) => check.status === "pass"),
    tag,
    version,
    checks,
  };
}

function readJson(rootDir, relativePath) {
  return JSON.parse(readText(rootDir, relativePath));
}

function readText(rootDir, relativePath) {
  return readFileSync(resolve(rootDir, relativePath), "utf8");
}

function readStringConstant(text, name) {
  const match = new RegExp(`(?:const|export\\s+const)\\s+${escapeRegExp(name)}\\s*=\\s*"([^"]+)"`).exec(text);
  return match?.[1] ?? null;
}

function versionFromMcpTag(tag) {
  return stableMcpTagPattern.exec(tag)?.[1] ?? null;
}

function findMcpChangelogSection(changelog, version) {
  const headerPattern = new RegExp(`^## mcp-v${escapeRegExp(version)} - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  const match = headerPattern.exec(changelog);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const rest = changelog.slice(bodyStart);
  const nextHeader = rest.search(/\n## /);
  return {
    header: match[0],
    body: nextHeader === -1 ? rest : rest.slice(0, nextHeader),
  };
}

function normalizePackageFilePath(path) {
  return String(path ?? "")
    .trim()
    .replace(/^package\//, "");
}

export function sanitizeCommandOutput(value, extraRedactions = []) {
  let text = String(value ?? "");
  while (forbiddenPackageContent.test(text)) text = text.replace(forbiddenPackageContent, "<redacted>");
  for (const path of extraRedactions) {
    if (!path) continue;
    text = text.split(path).join("<local-path>");
  }
  if (process.env.HOME) text = text.split(process.env.HOME).join("<home>");
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const args = { tag: undefined, rootDir: process.cwd(), metadataOnly: false, fullCi: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      args.tag = argv[++index];
    } else if (arg === "--root") {
      args.rootDir = argv[++index];
    } else if (arg === "--metadata-only") {
      args.metadataOnly = true;
    } else if (arg === "--full-ci") {
      args.fullCi = true;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function printReport(report) {
  for (const check of report.checks) {
    const marker = check.status === "pass" ? "ok" : "fail";
    process.stdout.write(`${marker} ${check.name}: ${check.detail}\n`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = runMcpReleaseCandidate(args);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  if (!report.ok) process.exit(1);
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(entrypointPath).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
