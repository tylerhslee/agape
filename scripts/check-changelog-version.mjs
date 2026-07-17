#!/usr/bin/env node
// Tag <-> changelog consistency: the version declared in VERSION.md must have a
// matching `## [<version>]` release heading in CHANGELOG.md. check-version.mjs
// deliberately ignores CHANGELOG.md, so this closes that gap. Cheap + deterministic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = (() => {
  const m = readFileSync(join(repo, "VERSION.md"), "utf8").match(/Version:\s*`([^`]+)`/);
  if (!m) { console.error("FATAL: could not read Version from VERSION.md."); process.exit(1); }
  return m[1];
})();

const changelog = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
// Match a Keep-a-Changelog release heading: "## [<version>]" (date/suffix optional).
const heading = new RegExp(`^##\\s*\\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m");

if (!heading.test(changelog)) {
  console.error(`Tag/changelog drift: VERSION.md is ${version} but CHANGELOG.md has no '## [${version}]' heading.`);
  console.error("Add a release section for this version to CHANGELOG.md before tagging.");
  process.exit(1);
}
console.log(`Tag/changelog in sync: CHANGELOG.md has a '## [${version}]' release heading.`);
