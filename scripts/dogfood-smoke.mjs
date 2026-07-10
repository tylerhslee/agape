#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectsRoot = path.resolve(repoRoot, "..");
const agapeCli = path.join(repoRoot, "agape-ts", "src", "cli.ts");
const tsxCli = path.join(repoRoot, "agape-ts", "node_modules", "tsx", "dist", "cli.mjs");

const flags = new Set(process.argv.slice(2));
const emitJson = flags.has("--json");
const strict = flags.has("--strict");

function runAgape(args, options = {}) {
  const result = spawnSync(process.execPath, [tsxCli, agapeCli, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
  });

  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function summarizeFailure(result) {
  const combined = [result.stderr, result.stdout].filter(Boolean).join("\n");
  const firstLine = combined.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine?.slice(0, 240) ?? "command failed without output";
}

function factCheckerSmoke() {
  const projectRoot = path.join(projectsRoot, "agape-fact-checker");
  const mainFile = path.join(projectRoot, "main.ag");
  const manifest = path.join(projectRoot, "agape.toml");

  if (!existsSync(projectRoot)) {
    return {
      project: "agape-fact-checker",
      status: "missing_project",
      path: projectRoot,
      detail: "Sibling project was not found.",
    };
  }

  if (!existsSync(mainFile) || !existsSync(manifest)) {
    return {
      project: "agape-fact-checker",
      status: "missing_agape_entrypoint",
      path: projectRoot,
      detail: "Expected main.ag and agape.toml.",
    };
  }

  const result = runAgape(["check", "main.ag", "--manifest", "agape.toml", "--provider", "mock", "--json"], {
    cwd: projectRoot,
  });

  if (result.status === 0) {
    return {
      project: "agape-fact-checker",
      status: "passed",
      path: projectRoot,
      detail: "Agape entrypoint validates against the current TypeScript runtime.",
    };
  }

  return {
    project: "agape-fact-checker",
    status: "needs_migration",
    path: projectRoot,
    detail: summarizeFailure(result),
  };
}

function leagueAnalyzerSmoke() {
  const projectRoot = path.join(projectsRoot, "league-analyzer");

  if (!existsSync(projectRoot)) {
    return {
      project: "league-analyzer",
      status: "missing_project",
      path: projectRoot,
      detail: "Sibling project was not found.",
    };
  }

  const hasManifest = existsSync(path.join(projectRoot, "agape.toml"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), "agape-league-dogfood-"));
  const fixture = path.join(tempRoot, "league-advisor.ag");

  const source = String.raw`prompt text MatchNote;
enum Advice { Publish, Revise }
action Recommend(text body);

agent LeagueAdvisor grants { perform Recommend } {
  when (Prompt p about MatchNote) {
    mem note <- "League analyzer dogfood prefers concise, evidence-backed feedback.";
    text answer = f"Use recent form, injuries, and matchup context before publishing: {p.text}";
    Credence<Advice> c = self <- f"safe league feedback: {answer}";
    Decision<Advice> d = decide c by confidence 0.5;
    if (d.committed == Publish) {
      Endorsement<text> e = endorse answer by d;
      perform Recommend(e);
    }
  }
}

spawn LeagueAdvisor advisor;
`;

  try {
    writeFileSync(fixture, source);
    const result = runAgape(
      [
        "run",
        fixture,
        "--provider",
        "mock",
        "--json",
        "--prompt",
        "MatchNote=Will the home favorite maintain pace after two injuries?",
      ],
      { cwd: projectRoot },
    );

    if (result.status !== 0) {
      return {
        project: "league-analyzer",
        status: "fixture_failed",
        path: projectRoot,
        detail: summarizeFailure(result),
      };
    }

    return {
      project: "league-analyzer",
      status: hasManifest ? "passed" : "needs_app_hook",
      path: projectRoot,
      detail: hasManifest
        ? "Agape fixture ran and the app has an agape.toml hook."
        : "Agape fixture ran, but the app does not expose an agape.toml hook yet.",
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function somaDeploymentSmoke() {
  const projectRoot = path.join(projectsRoot, "agape-soma");
  const moduleFile = path.join(projectRoot, "modules", "agape-app", "main.tf");
  const templateReadme = path.join(projectRoot, "templates", "agape-app", "README.md");
  const entrypoint = path.join(projectRoot, "templates", "agape-app", "scripts", "cloud-entrypoint.sh");
  const studioScript = path.join(projectRoot, "templates", "agape-app", "scripts", "studio-cloud.sh");

  if (!existsSync(projectRoot)) {
    return {
      project: "agape-soma",
      status: "missing_project",
      path: projectRoot,
      detail: "Sibling deployment project was not found.",
    };
  }

  const required = [moduleFile, templateReadme, entrypoint, studioScript];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    return {
      project: "agape-soma",
      status: "missing_template",
      path: projectRoot,
      detail: `Missing ${missing.map((file) => path.relative(projectRoot, file)).join(", ")}.`,
    };
  }

  const readme = readFileSync(templateReadme, "utf8");
  const entrypointText = readFileSync(entrypoint, "utf8");
  const studioText = readFileSync(studioScript, "utf8");
  const moduleText = readFileSync(moduleFile, "utf8");
  const expectations = [
    [readme.includes("modules/agape-app?ref=v0.3.0"), "template README pins the agape-app module at v0.3.0"],
    [entrypointText.includes("AGAPE_PROJECT_DIR") && entrypointText.includes("AGAPE_SEED_DIR"), "entrypoint seeds a persistent Agape project directory"],
    [studioText.includes("studio --port") && studioText.includes("--live"), "Studio starts in live mode against the shared project"],
    [moduleText.includes("mount_state      = true") && moduleText.includes(".agape/memory"), "module documents/shared state for markdown memory"],
  ];
  const failed = expectations.filter(([ok]) => !ok).map(([, message]) => message);

  if (failed.length > 0) {
    return {
      project: "agape-soma",
      status: "contract_drift",
      path: projectRoot,
      detail: failed.join("; "),
    };
  }

  return {
    project: "agape-soma",
    status: "passed",
    path: projectRoot,
    detail: "v0.3.0 agape-app deployment contract matches project-root Agape + persistent markdown memory.",
  };
}
const results = [factCheckerSmoke(), leagueAnalyzerSmoke(), somaDeploymentSmoke()];
const hasBlockingStatus = results.some((result) => result.status !== "passed");

if (emitJson) {
  console.log(JSON.stringify({ strict, results }, null, 2));
} else {
  console.log("Agape dogfood smoke:");
  for (const result of results) {
    console.log(`- ${result.project}: ${result.status} (${result.detail})`);
  }
  if (hasBlockingStatus) {
    console.log("Run with --strict to make non-passing dogfood status fail CI.");
  }
}

if (strict && hasBlockingStatus) {
  process.exitCode = 1;
}