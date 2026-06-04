export type McpReleaseCandidateCheck = {
  name: string;
  status: "pass" | "fail";
  detail: string;
};

export type McpReleaseCandidateReport = {
  ok: boolean;
  tag: string;
  version?: string;
  checks: McpReleaseCandidateCheck[];
};

export function checkMcpReleaseCandidate(options?: {
  rootDir?: string;
  tag?: string;
  packageJsonPath?: string;
}): McpReleaseCandidateReport;

export function auditMcpPackageFiles(files: string[], readContent?: (rawFile: string, normalizedFile: string) => string): McpReleaseCandidateCheck[];

export function runMcpReleaseCandidate(options?: {
  rootDir?: string;
  tag?: string;
  packageJsonPath?: string;
  metadataOnly?: boolean;
  fullCi?: boolean;
}): McpReleaseCandidateReport;

export function sanitizeCommandOutput(value: unknown, extraRedactions?: string[]): string;
