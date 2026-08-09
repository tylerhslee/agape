import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTempProject, eventsOf, fixture, payloadObject, readTree, runCli, runDiagnostic, sentinel,
  type TempProject,
} from "./harness.js";

interface NumericLeaf { path: string; value: number }

function numericLeaves(value: unknown, path = ""): NumericLeaf[] {
  if (typeof value === "number") return [{ path, value }];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => numericLeaves(child, path ? `${path}.${key}` : key));
}

function positivePaths(value: unknown): string[] {
  return numericLeaves(value).filter((entry) => entry.value > 0).map((entry) => entry.path);
}

function expectNoFabricatedModalities(effects: unknown, label: string): void {
  const positives = positivePaths(effects);
  expect.soft(positives.filter((path) => /(^|\.)(facts?|graph|vectors?|embeddings?)(\.|$)/i.test(path)),
    `${label}: receipt claimed an unmaterialized fact/graph/vector/embedding effect`).toEqual([]);
}

function substratePaths(refs: unknown): string[] {
  return Array.isArray(refs)
    ? refs.filter((ref): ref is string => typeof ref === "string" && ref.startsWith("substrate:"))
      .map((ref) => ref.slice("substrate:".length))
    : [];
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
    const store = eventsOf(result, "Internalized")[0];
    const forget = eventsOf(result, "Forgotten")[0];
    expect.soft(eventsOf(result, "Internalized"), "P06: explicit store requires exactly one receipt").toHaveLength(1);
    expect.soft(eventsOf(result, "Forgotten"), "P06: explicit forget requires exactly one receipt").toHaveLength(1);
    const spawnedId = payloadObject(eventsOf(result, "Spawned")[0]).instance_id;
    const storePayload = payloadObject(store);
    const forgetPayload = payloadObject(forget);

    expect.soft(spawnedId).toMatch(/^agent-instance-v1:[0-9a-f]{64}$/);
    expect.soft(store?.agent, "P06: receipt must use the stable concrete instance subject").toBe(spawnedId);
    expect.soft(forget?.agent).toBe(spawnedId);
    expect.soft(store?.subject).toBe("notes");
    expect.soft(forget?.subject).toBe("notes");
    expect.soft(storePayload).toMatchObject({
      operation: "store",
      write_source: "explicit_store",
      generation: 0,
      operation_id: expect.stringMatching(/^memory-operation-v1:[0-9a-f]{64}$/),
      origin_ref: expect.stringMatching(/^memory-origin-v1:[0-9a-f]{64}$/),
      value_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      effects: {
        cells: { upserted: 1, tombstoned: 0 },
        blobs: { archived: 0, deleted: 0 },
      },
      refs: expect.any(Array),
    });
    expect.soft(forgetPayload).toMatchObject({
      operation: "forget",
      generation: 0,
      operation_id: expect.stringMatching(/^memory-operation-v1:[0-9a-f]{64}$/),
      origin_ref: expect.stringMatching(/^memory-origin-v1:[0-9a-f]{64}$/),
      already_forgotten: false,
      effects: {
        cells: { upserted: 0, tombstoned: 1 },
        blobs: { archived: 1, deleted: 0 },
      },
      refs: expect.any(Array),
    });
    expect.soft(JSON.stringify(store), "P06: Internalized leaked private plaintext").not.toContain(secret);
    expect.soft(JSON.stringify(forget), "P06: Forgotten leaked private plaintext").not.toContain(secret);
    expectNoFabricatedModalities(storePayload.effects, "P06 Internalized");
    expectNoFabricatedModalities(forgetPayload.effects, "P06 Forgotten");

    const tree = await readTree(join(project.root, ".agape", "memory"));
    const storePaths = substratePaths(storePayload.refs);
    const forgetPaths = substratePaths(forgetPayload.refs);
    expect.soft(storePaths, "P06: store must expose canonical and derived projection refs").toHaveLength(2);
    expect.soft(forgetPaths, "P06: forget must expose canonical, projection, and archive refs").toHaveLength(3);
    for (const path of new Set([...storePaths, ...forgetPaths])) {
      expect.soft(tree[path], `P06: substrate ref does not resolve: ${path}`).toEqual(expect.any(String));
    }
    expect.soft(storePaths).toContain(".agape-memory-v1/state.json");
    expect.soft(forgetPaths).toContain(".agape-memory-v1/state.json");
    const archivePath = forgetPaths.find((path) => path.includes("/.archive/") && path.endsWith(".md"));
    expect.soft(archivePath, "P06: archive receipt omitted its canonical projection ref").toEqual(expect.any(String));
    if (archivePath) expect.soft(tree[archivePath], "P06: canonical archive lost the forgotten value").toContain(secret);
    const livePath = forgetPaths.find((path) => path.includes("/generation-0/") && path.endsWith("/MEMORY.md"));
    expect.soft(livePath, "P06: forget receipt omitted the closed generation projection").toEqual(expect.any(String));
    expect.soft(livePath ? tree[livePath] : "", "P06: closed generation projection did not record forgotten state")
      .toContain("- state: closed");
    expect.soft(livePath ? tree[livePath] : "", "P06: closed generation retained private plaintext").not.toContain(secret);
  });
});
