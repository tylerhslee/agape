import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTempProject,
  eventsOf,
  fixture,
  payloadObject,
  readTree,
  runCli,
  runDiagnostic,
  sentinel,
  type TempProject,
} from "./harness.js";

interface NumericLeaf {
  path: string;
  value: number;
}

function numericLeaves(value: unknown, path = ""): NumericLeaf[] {
  if (typeof value === "number") return [{ path, value }];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => numericLeaves(child, path ? `${path}.${key}` : key));
}

function positivePaths(value: unknown): string[] {
  return numericLeaves(value).filter((entry) => entry.value > 0).map((entry) => entry.path);
}

function expectNoFabricatedMarkdownModalities(effects: unknown, label: string): void {
  const positives = positivePaths(effects);
  expect.soft(positives.filter((path) => /(^|\.)(facts?|graph|vectors?|embeddings?)(\.|$)/i.test(path)),
    `${label}: markdown claimed an unmaterialized fact/graph/vector/embedding effect`).toEqual([]);
}

function expectResolvableMarkdownRefs(
  tree: Record<string, string>,
  refs: Record<string, unknown>,
  label: string,
): void {
  for (const key of ["markdown_file", "markdown_index"]) {
    expect.soft(refs[key], `${label}: missing ${key}`).toEqual(expect.any(String));
    if (typeof refs[key] === "string") {
      expect.soft(tree[refs[key]], `${label}: ${key} does not resolve to configured substrate state`)
        .toEqual(expect.any(String));
    }
  }
  expect.soft(Object.keys(refs).filter((key) => /(?:^|_)(?:input|facts|graph|vector)_delta$/i.test(key)),
    `${label}: receipt exposed synthetic delta refs with no configured backing store`).toEqual([]);
}

describe("P06 production truthful Markdown memory receipts", () => {
  let project: TempProject | undefined;

  afterEach(async () => {
    await project?.cleanup();
  });

  it("[P06.markdown-modality-receipts] reports only committed Markdown effects and resolvable refs", async () => {
    const secret = sentinel("P06_PRIVATE_MEMORY");
    project = await createTempProject(sentinel("p06-project"));
    const file = await project.write("main.ag", await fixture("p06/modality_receipts.ag.tmpl", { SENTINEL: secret }));
    const result = await runCli({ project, file });

    expect(result.json?.ok, runDiagnostic(result)).toBe(true);
    const stores = eventsOf(result, "Internalized");
    const forgotten = eventsOf(result, "Forgotten");
    expect.soft(stores, "P06: explicit store requires exactly one receipt").toHaveLength(1);
    expect.soft(forgotten, "P06: explicit forget requires exactly one receipt").toHaveLength(1);
    const store = stores[0];
    const forget = forgotten[0];
    const storePayload = payloadObject(store);
    const forgetPayload = payloadObject(forget);

    expect.soft(store?.agent).toBe("archivist");
    expect.soft(store?.subject).toBe("notes");
    expect.soft(storePayload).toMatchObject({
      write_source: "explicit_store",
      value_hash: expect.any(String),
      value_ref: expect.any(String),
      effects: expect.any(Object),
      refs: expect.any(Object),
    });
    expect.soft(String(storePayload.value_hash)).not.toContain(secret);
    expect.soft(String(storePayload.value_ref)).not.toContain(secret);
    expect.soft(JSON.stringify(store), "P06: Internalized leaked private plaintext").not.toContain(secret);
    expect.soft(JSON.stringify(forget), "P06: Forgotten leaked private plaintext").not.toContain(secret);

    expectNoFabricatedMarkdownModalities(storePayload.effects, "P06 Internalized");
    const storePositive = positivePaths(storePayload.effects);
    expect.soft(storePositive.some((path) => /(?:cell|canonical|markdown|chunk)/i.test(path)),
      "P06: successful store reported no committed canonical/Markdown effect").toBe(true);
    expect.soft(storePositive.filter((path) => /blobs?\.(?:archived|redacted|deleted)$/i.test(path)),
      "P06: ordinary Markdown store falsely claimed archival/redaction/deletion").toEqual([]);

    expectNoFabricatedMarkdownModalities(forgetPayload.effects, "P06 Forgotten");
    const forgetPositive = positivePaths(forgetPayload.effects);
    expect.soft(forgetPositive.some((path) => /tombston/i.test(path)),
      "P06: forget did not report the active-cell tombstone").toBe(true);
    expect.soft(forgetPositive.some((path) => /archiv/i.test(path)),
      "P06: archive_on_forget=true did not report the committed archive").toBe(true);
    expect.soft(forgetPositive.filter((path) => /(?:redact|delet)/i.test(path)),
      "P06: archive-on-forget falsely reported redaction or deletion").toEqual([]);

    const tree = await readTree(join(project.root, ".agape", "memory"));
    const storeRefs = storePayload.refs as Record<string, unknown>;
    const forgetRefs = forgetPayload.refs as Record<string, unknown>;
    expectResolvableMarkdownRefs(tree, storeRefs, "P06 Internalized");
    expectResolvableMarkdownRefs(tree, forgetRefs, "P06 Forgotten");
    expect.soft(forgetRefs.markdown_archive, "P06: archive receipt omitted the archive ref")
      .toEqual(expect.any(String));
    if (typeof forgetRefs.markdown_archive === "string") {
      expect.soft(tree[forgetRefs.markdown_archive], "P06: archive ref is not resolvable").toContain(secret);
    }
    if (typeof forgetRefs.markdown_file === "string") {
      expect.soft(tree[forgetRefs.markdown_file], "P06: live topic ref is not resolvable").toContain("agape-forgotten");
      expect.soft(tree[forgetRefs.markdown_file], "P06: forgotten live topic retained private plaintext").not.toContain(secret);
    }
  });
});
