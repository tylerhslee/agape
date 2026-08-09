import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rename as fsRename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownTransactionalNamedMemoryDriver } from "../src/named_memory_markdown.js";
import { encodeExactValue, type MemoryRegionKeyInput, type ResolvedMemoryDescriptor } from "../src/named_memory.js";
import type { NamedMemoryMutationContext } from "../src/named_memory_local.js";
import type { Value } from "../src/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "agape-markdown-memory-"));
  roots.push(created);
  return created;
}

function descriptor(
  schema: ResolvedMemoryDescriptor["schema"] = { kind: "scalar", name: "text" },
  retention: "session" | "durable" = "durable",
  name = "project",
): ResolvedMemoryDescriptor {
  return { name, schema, modality: "episodic", scopes: ["project", "user"], retention };
}

function region(): Omit<MemoryRegionKeyInput, "descriptor"> {
  return {
    projectSubject: "private-project-subject",
    sessionLineageId: "private-lineage",
    sessionId: "private-session",
    stableAgentInstanceId: `agent-instance-v1:${"a".repeat(64)}`,
    user: { issuer: "https://private-idp.example", subject: "private-user", verified: true },
  };
}

function context(
  memory: ResolvedMemoryDescriptor,
  ordinal = 0,
): NamedMemoryMutationContext {
  return {
    descriptor: memory,
    region: region(),
    site: "app.ag:19:5",
    origin: { invocationCorrelation: "private-invocation", evaluationOrdinal: ordinal },
  };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function canonicalJsonForTest(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForTest).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonForTest(record[key])}`).join(",")}}`;
}

async function rewriteCanonical(directory: string, mutate: (payload: any) => void): Promise<void> {
  const path = join(directory, ".agape-memory-v1", "state.json");
  const document = JSON.parse(await readFile(path, "utf8"));
  mutate(document.payload);
  document.checksum = createHash("sha256")
    .update("agape.markdown-memory-state.v1", "utf8").update("\0", "utf8")
    .update(canonicalJsonForTest(document.payload), "utf8").digest("hex");
  await writeFile(path, `${canonicalJsonForTest(document)}\n`, "utf8");
}

describe("filesystem-backed Markdown named memory", () => {
  it("round-trips exact scalar, struct, and array values across a fresh driver instance", async () => {
    const directory = await root();
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    const cases: { descriptor: ResolvedMemoryDescriptor; value: Value }[] = [
      {
        descriptor: descriptor({ kind: "scalar", name: "text" }, "durable", "scalar"),
        value: { kind: "text", v: "verbatim: 001\n# not metadata", trust: "graded" },
      },
      {
        descriptor: descriptor({
          kind: "struct",
          name: "ProjectEvent",
          fields: [
            { name: "count", schema: { kind: "scalar", name: "int" } },
            { name: "label", schema: { kind: "scalar", name: "text" } },
          ],
        }, "durable", "struct"),
        value: {
          kind: "struct",
          typeName: "ProjectEvent",
          fields: new Map([
            ["label", { kind: "text", v: "shipped", trust: "settled" }],
            ["count", { kind: "int", v: 7, trust: "raw" }],
          ]),
          trust: "raw",
        },
      },
      {
        descriptor: descriptor({ kind: "array", items: { kind: "scalar", name: "bool" } }, "durable", "array"),
        value: {
          kind: "array",
          items: [
            { kind: "bool", v: true, trust: "settled" },
            { kind: "bool", v: false, trust: "graded" },
          ],
          trust: "graded",
        },
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index]!;
      const stage = await driver.prepareStore({
        ...context(item.descriptor, index),
        value: item.value,
      });
      await driver.finalize(stage.operationId, { tick: index + 1, head: `head-${index + 1}` });
    }
    await driver.close();

    const restarted = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    for (const item of cases) {
      const recall = await restarted.recall({ descriptor: item.descriptor, region: region() });
      expect(recall.values).toEqual([encodeExactValue(item.value, item.descriptor.schema)]);
    }
    await restarted.close();
  });

  it("durably stages prepared mutations invisibly and reconciles a ledger-committed mutation after restart", async () => {
    const directory = await root();
    const memory = descriptor();
    const first = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    const stage = await first.prepareStore({
      ...context(memory),
      value: { kind: "text", v: "prepared exact value", trust: "raw" },
    });
    expect((await first.recall({ descriptor: memory, region: region() })).values).toEqual([]);
    await first.close();

    const restarted = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    expect(await restarted.status(stage.operationId)).toEqual({ status: "prepared", stage });
    expect((await restarted.recall({ descriptor: memory, region: region() })).values).toEqual([]);
    const reconciled = await restarted.reconcile(stage.operationId, { tick: 41, head: "ledger-head-41" });
    expect(reconciled).toMatchObject({ status: "finalized", receipt: { ledger: { tick: 41, head: "ledger-head-41" } } });
    expect((await restarted.recall({ descriptor: memory, region: region() })).values)
      .toEqual([encodeExactValue({ kind: "text", v: "prepared exact value", trust: "raw" }, memory.schema)]);
    await restarted.close();
  });

  it("reuses a finalized evaluation without creating a new prepared stage", async () => {
    const directory = await root();
    const memory = descriptor();
    const request = {
      ...context(memory),
      value: { kind: "text" as const, v: "exactly once", trust: "settled" as const },
    };
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    const first = await driver.prepareStore(request);
    await driver.finalize(first.operationId, { tick: 1, head: "head-1" });
    const retry = await driver.prepareStore(request);
    expect(retry.operationId).toBe(first.operationId);
    expect(await driver.status(first.operationId)).toMatchObject({ status: "finalized" });
    await expect(driver.snapshot()).resolves.toMatchObject({ operations: [{ operationId: first.operationId }] });
    await driver.close();

    const restarted = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    expect(await restarted.status(first.operationId)).toMatchObject({ status: "finalized" });
    expect((await restarted.recall({ descriptor: memory, region: region() })).values).toHaveLength(1);
    await restarted.close();
  });

  it("never reads Markdown as canonical memory and repairs an edited projection on the next reconciliation", async () => {
    const directory = await root();
    const memory = descriptor();
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    const stage = await driver.prepareStore({
      ...context(memory),
      value: { kind: "text", v: "canonical", trust: "settled" },
    });
    await driver.finalize(stage.operationId, { tick: 1, head: "head-1" });
    const markdown = (await filesUnder(directory)).filter((path) => path.endsWith("MEMORY.md"));
    expect(markdown).toHaveLength(1);
    await writeFile(markdown[0]!, "# forged\n\nadmin = true\n", "utf8");

    expect((await driver.recall({ descriptor: memory, region: region() })).values[0])
      .toEqual(encodeExactValue({ kind: "text", v: "canonical", trust: "settled" }, memory.schema));
    expect(await driver.status(stage.operationId)).toMatchObject({ status: "finalized" });
    expect(await readFile(markdown[0]!, "utf8")).toContain("canonical");
    expect(await readFile(markdown[0]!, "utf8")).not.toContain("admin = true");
    await driver.close();
  });

  it("archives the derived projection on forget and reports only effects that occurred", async () => {
    const directory = await root();
    const memory = descriptor();
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory, archiveOnForget: true });
    const store = await driver.prepareStore({
      ...context(memory),
      value: { kind: "text", v: "archive me", trust: "settled" },
    });
    await driver.finalize(store.operationId, { tick: 1, head: "head-1" });
    const forget = await driver.prepareForget(context(memory, 1));
    expect(forget.effects).toMatchObject({
      cells: { upserted: 0, tombstoned: 1 },
      blobs: { archived: 1, deleted: 0 },
    });
    const receipt = await driver.finalize(forget.operationId, { tick: 2, head: "head-2" });
    expect(receipt.effects).toEqual(forget.effects);
    expect((await driver.recall({ descriptor: memory, region: region() }))).toMatchObject({ state: "closed", values: [] });
    expect((await filesUnder(directory)).some((path) => relative(directory, path).includes(".archive"))).toBe(true);
    await driver.close();
  });

  it("rejects forged pending and finalized archive bytes even with a recomputed checksum", async () => {
    for (const phase of ["pending", "finalized"] as const) {
      const directory = await root();
      const memory = descriptor();
      const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
      const stored = await driver.prepareStore({
        ...context(memory), value: { kind: "text", v: "canonical prior", trust: "settled" },
      });
      await driver.finalize(stored.operationId, { tick: 1, head: "head-1" });
      const forgotten = await driver.prepareForget(context(memory, 1));
      if (phase === "finalized") await driver.finalize(forgotten.operationId, { tick: 2, head: "head-2" });
      await driver.close();
      await rewriteCanonical(directory, (payload) => {
        if (phase === "pending") payload.pending[0].projectionBefore = "# forged\n";
        else payload.finalized[forgotten.operationId].projectionBefore = "# forged\n";
      });
      await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory }))
        .rejects.toThrow(/canonical|projection|metadata|prepared/i);
    }
  });

  it("adopts an exact state revision when rename succeeds but durability sync reports failure", async () => {
    const directory = await root();
    let armed: "prepare" | "finalize" | undefined;
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({
      root: directory,
      testHooks: {
        onFilesystemPhase(phase) {
          if (phase === "state-after-rename" && armed !== undefined) {
            armed = undefined;
            const error = new Error("injected post-rename EIO") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
        },
      },
    });
    const memory = descriptor();
    armed = "prepare";
    const stage = await driver.prepareStore({
      ...context(memory), value: { kind: "text", v: "adopt me", trust: "settled" },
    });
    expect(await driver.status(stage.operationId)).toMatchObject({ status: "prepared" });
    armed = "finalize";
    await driver.finalize(stage.operationId, { tick: 1, head: "head-1" });
    expect(await driver.status(stage.operationId)).toMatchObject({ status: "finalized" });
    await driver.close();
    const restarted = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    expect(await restarted.status(stage.operationId)).toMatchObject({ status: "finalized" });
    await restarted.close();
  });

  it("uses opaque fixed layout segments and rejects path-shaped entrypoint names", async () => {
    const directory = await root();
    const memory = descriptor();
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory, entrypoint: "INDEX" });
    const stage = await driver.prepareStore({
      ...context(memory),
      value: { kind: "text", v: "private value", trust: "settled" },
    });
    await driver.finalize(stage.operationId, { tick: 1, head: "head-1" });
    const paths = (await filesUnder(directory)).map((path) => relative(directory, path));
    expect(paths.some((path) => path.endsWith("INDEX.md"))).toBe(true);
    for (const path of paths) {
      for (const secret of ["private-project-subject", "private-lineage", "private-session", "private-user", "private-idp"]) {
        expect(path).not.toContain(secret);
      }
      expect(path.split(/[\\/]/)).not.toContain("..");
    }
    await driver.close();

    await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory }))
      .rejects.toThrow(/projection|malformed|checksum/i);

    await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory, entrypoint: "../escape.md" }))
      .rejects.toThrow(/entrypoint/i);
    await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory, entrypoint: "nested/escape.md" }))
      .rejects.toThrow(/entrypoint/i);
  });

  it("keeps the session tier process-local and never persists its cells", async () => {
    const directory = await root();
    const memory = descriptor({ kind: "scalar", name: "text" }, "session", "working");
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    const before = await filesUnder(directory);
    const stage = await driver.prepareStore({
      ...context(memory),
      value: { kind: "text", v: "working-only", trust: "raw" },
    });
    const sessionReceipt = await driver.finalize(stage.operationId, { tick: 1, head: "head-1" });
    expect(sessionReceipt.effects).toEqual(stage.effects);
    expect(sessionReceipt.refs).toEqual(stage.refs);
    expect((await driver.recall({ descriptor: memory, region: region() })).values).toHaveLength(1);
    const durable = descriptor({ kind: "scalar", name: "text" }, "durable", "long-term");
    const durableStage = await driver.prepareStore({
      ...context(durable, 1),
      value: { kind: "text", v: "durable", trust: "settled" },
    });
    await driver.finalize(durableStage.operationId, { tick: 2, head: "head-2" });
    expect(await driver.status(stage.operationId)).toMatchObject({
      status: "finalized",
      receipt: { operationId: stage.operationId },
    });
    expect((await driver.recall({ descriptor: memory, region: region() })).values).toHaveLength(1);
    const after = await filesUnder(directory);
    expect(after.length).toBeGreaterThan(before.length);
    expect((await Promise.all(after.map((path) => readFile(path, "utf8")))).join("\n"))
      .not.toContain("working-only");
    await driver.close();

    const restarted = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    expect((await restarted.recall({ descriptor: memory, region: region() })).values).toEqual([]);
    await restarted.close();
  });

  it("recovers a prepared stage after an ungraceful writer death without permitting a fork", async () => {
    const directory = await root();
    const moduleUrl = new URL("../src/named_memory_markdown.ts", import.meta.url).href;
    const childScript = `
      import { MarkdownTransactionalNamedMemoryDriver } from ${JSON.stringify(moduleUrl)};
      const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: ${JSON.stringify(directory)} });
      const stage = await driver.prepareStore({
        descriptor: {
          name: "project", schema: { kind: "scalar", name: "text" }, modality: "episodic",
          scopes: ["project", "user"], retention: "durable"
        },
        region: {
          projectSubject: "private-project-subject", sessionLineageId: "private-lineage",
          sessionId: "private-session", stableAgentInstanceId: "agent-instance-v1:${"a".repeat(64)}",
          user: { issuer: "https://private-idp.example", subject: "private-user", verified: true }
        },
        site: "app.ag:19:5",
        origin: { invocationCorrelation: "private-invocation", evaluationOrdinal: 0 },
        value: { kind: "text", v: "survives-crash", trust: "raw" }
      });
      process.stdout.write(stage.operationId + "\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const operationId = await new Promise<string>((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline >= 0) resolve(output.slice(0, newline));
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`writer exited before ready (${String(code)})`)));
    });
    child.kill("SIGKILL");
    await once(child, "exit");

    const leasePath = join(directory, ".agape-memory-v1", "writer.lock");
    const staleLease = JSON.parse(await readFile(leasePath, "utf8")) as { token: string };
    const generation = createHash("sha256")
      .update("agape.markdown-memory-path.stale-lease.v1", "utf8")
      .update("\0", "utf8")
      .update(staleLease.token, "utf8")
      .digest("hex");
    await writeFile(
      join(directory, ".agape-memory-v1", `takeover-${generation}-${"0".repeat(64)}.claim`),
      JSON.stringify({
        version: 1,
        token: "0".repeat(64),
        pid: 2_147_483_647,
        processStart: null,
      }),
      "utf8",
    );

    const recovered = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    expect(await recovered.status(operationId)).toMatchObject({ status: "prepared" });
    await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory }))
      .rejects.toThrow(/writer|lease|already open/i);
    await recovered.close();
  });

  it("recovers when a process dies after syncing but before publishing its lease", async () => {
    const directory = await root();
    const moduleUrl = new URL("../src/named_memory_markdown.ts", import.meta.url).href;
    const childScript = `
      import { MarkdownTransactionalNamedMemoryDriver } from ${JSON.stringify(moduleUrl)};
      await MarkdownTransactionalNamedMemoryDriver.open({
        root: ${JSON.stringify(directory)},
        testHooks: { onFilesystemPhase(phase) {
          if (phase === "lease-temp-synced") process.kill(process.pid, "SIGKILL");
        } }
      });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
      cwd: new URL("..", import.meta.url), stdio: "ignore",
    });
    await once(child, "exit");
    const recovered = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    await recovered.close();
  });

  it("fences a parent-directory symlink swap before publishing private temporary bytes", async () => {
    const directory = await root();
    const outside = await root();
    let armed = false;
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({
      root: directory,
      testHooks: {
        async onFilesystemPhase(phase) {
          if (phase !== "state-before-rename" || !armed) return;
          armed = false;
          const internal = join(directory, ".agape-memory-v1");
          await fsRename(internal, join(directory, ".moved-memory"));
          await symlink(outside, internal);
        },
      },
    });
    armed = true;
    await expect(driver.prepareStore({
      ...context(descriptor()), value: { kind: "text", v: "must not escape", trust: "raw" },
    })).rejects.toThrow(/fenced|path|directory|revision|lease/i);
    const outsideBytes = await Promise.all((await filesUnder(outside)).map((path) => readFile(path, "utf8")));
    expect(outsideBytes.join("\n")).not.toContain("must not escape");
  });

  it("holds an exclusive writer lease so two runtimes cannot fork one durable revision", async () => {
    const directory = await root();
    const first = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory }))
      .rejects.toThrow(/writer|lease|already open/i);
    await first.close();

    const next = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    const canonical = (await filesUnder(directory)).find((path) => path.endsWith("state.json"));
    expect(canonical).toBeDefined();
    expect(JSON.parse(await readFile(canonical!, "utf8")).payload.revision).toBeGreaterThanOrEqual(1);
    await next.close();
  });

  it("renders every named path placeholder as a domain-separated opaque segment", async () => {
    const directory = await root();
    const pathTemplate = [
      "{project}", "lineages", "{lineage}", "agents", "{agent}",
      "memories", "{mem}", "users", "{user}", "generations", "{generation}",
    ].join("/");
    const memory = descriptor({ kind: "scalar", name: "text" }, "durable", "private-memory-name");
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory, pathTemplate });
    const stored = await driver.prepareStore({
      ...context(memory), value: { kind: "text", v: "private value", trust: "settled" },
    });
    await driver.finalize(stored.operationId, { tick: 1, head: "head-1" });
    const storedPath = stored.refs.projection!.replace(/^substrate:/, "").split(/[\\/]/);
    expect(storedPath.slice(0, 11)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      "lineages", expect.stringMatching(/^[0-9a-f]{64}$/),
      "agents", expect.stringMatching(/^[0-9a-f]{64}$/),
      "memories", expect.stringMatching(/^[0-9a-f]{64}$/),
      "users", expect.stringMatching(/^[0-9a-f]{64}$/),
      "generations", expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    for (const secret of [
      "private-project-subject", "private-lineage", "private-memory-name",
      "private-user", "private-idp", "agent-instance-v1",
    ]) expect(stored.refs.projection).not.toContain(secret);

    const forgotten = await driver.prepareForget(context(memory, 1));
    await driver.finalize(forgotten.operationId, { tick: 2, head: "head-2" });
    const reopened = await driver.prepareStore({
      ...context(memory, 2), value: { kind: "text", v: "new generation", trust: "settled" },
    });
    const reopenedPath = reopened.refs.projection!.replace(/^substrate:/, "").split(/[\\/]/);
    expect(reopenedPath[10]).not.toBe(storedPath[10]);
    await driver.finalize(reopened.operationId, { tick: 3, head: "head-3" });
    await driver.close();

    const restarted = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory, pathTemplate });
    expect(await restarted.status(reopened.operationId)).toMatchObject({ status: "finalized" });
    await restarted.close();
    await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory }))
      .rejects.toThrow(/projection|template|configuration|malformed/i);
  });

  it("rejects unsafe or ambiguous named path templates before acquiring a writer lease", async () => {
    for (const pathTemplate of [
      "/{project}", "../{project}", "{project}/../{agent}",
      "prefix-{project}", "{unknown}", "{project}//{agent}", "static/{agent}",
      "{project}/AUX", "{project}/bad:name", "{project}/trailing. ",
      "{project}/CON .md", "{project}/COM¹.txt", "{project}/bad\u0001name",
    ]) {
      const directory = await root();
      await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory, pathTemplate }))
        .rejects.toThrow(/template|placeholder|relative|segment|travers/i);
      expect(await filesUnder(directory)).toEqual([]);
    }
  });

  it("rejects Windows ADS, device, and trailing-dot entrypoint names on every platform", async () => {
    for (const entrypoint of [
      "private:stream.md", "CON.md", "CON .md", "LPT1", "COM1 .txt", "COM¹.md",
      "trailing.", "trailing ", "bad\u0001name.md", "bad\u001fname.md",
    ]) {
      const directory = await root();
      await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory, entrypoint }))
        .rejects.toThrow(/entrypoint|file name/i);
      expect(await filesUnder(directory)).toEqual([]);
    }
  });

  it("rejects a group/world-writable filesystem root before creating canonical state", async () => {
    if (process.platform === "win32") return;
    const directory = await root();
    await chmod(directory, 0o777);
    await expect(MarkdownTransactionalNamedMemoryDriver.open({ root: directory }))
      .rejects.toThrow(/owned|group|world|writable|root/i);
    expect(await filesUnder(directory)).toEqual([]);
    await chmod(directory, 0o700);
  });

  it("keeps close retryable until its ownership-checked lease release succeeds", async () => {
    const directory = await root();
    let failClose = true;
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({
      root: directory,
      testHooks: { onFilesystemPhase(phase) {
        if (phase === "close-before-lease-unlink" && failClose) {
          failClose = false;
          throw new Error("injected close failure");
        }
      } },
    });
    const stage = await driver.prepareStore({
      ...context(descriptor()), value: { kind: "text", v: "still open", trust: "raw" },
    });
    await driver.finalize(stage.operationId, { tick: 1, head: "head-1" });
    await expect(driver.close()).rejects.toThrow(/injected close failure/);
    await expect(driver.status(stage.operationId)).resolves.toMatchObject({ status: "finalized" });
    await driver.close();
    const reopened = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    await reopened.close();
  });

  it("removes only provably orphaned canonical and projection write temporaries after hard death", async () => {
    const directory = await root();
    const moduleUrl = new URL("../src/named_memory_markdown.ts", import.meta.url).href;
    const canonicalChild = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", `
        import { MarkdownTransactionalNamedMemoryDriver } from ${JSON.stringify(moduleUrl)};
        await MarkdownTransactionalNamedMemoryDriver.open({
          root: ${JSON.stringify(directory)},
          testHooks: { onFilesystemPhase(phase) {
            if (phase === "state-before-rename") process.kill(process.pid, "SIGKILL");
          } }
        });
      `,
    ], { cwd: new URL("..", import.meta.url), stdio: "ignore" });
    await once(canonicalChild, "exit");
    expect((await filesUnder(directory)).some((path) => /[/\\]\.tmp-/.test(path))).toBe(true);
    const recovered = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    await recovered.close();
    expect((await filesUnder(directory)).some((path) => /[/\\]\.tmp-/.test(path))).toBe(false);

    const projectionChild = spawn(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", `
        import { MarkdownTransactionalNamedMemoryDriver } from ${JSON.stringify(moduleUrl)};
        const driver = await MarkdownTransactionalNamedMemoryDriver.open({
          root: ${JSON.stringify(directory)},
          testHooks: { onFilesystemPhase(phase) {
            if (phase === "projection-before-rename") process.kill(process.pid, "SIGKILL");
          } }
        });
        const stage = await driver.prepareStore({
          descriptor: { name: "project", schema: { kind: "scalar", name: "text" },
            modality: "episodic", scopes: ["project", "user"], retention: "durable" },
          region: {
            projectSubject: "private-project-subject", sessionLineageId: "private-lineage",
            sessionId: "private-session", stableAgentInstanceId: "agent-instance-v1:${"a".repeat(64)}",
            user: { issuer: "https://private-idp.example", subject: "private-user", verified: true }
          },
          site: "projection-crash", origin: { invocationCorrelation: "projection-crash", evaluationOrdinal: 0 },
          value: { kind: "text", v: "projection survives", trust: "raw" }
        });
        await driver.finalize(stage.operationId, { tick: 1, head: "head-1" });
      `,
    ], { cwd: new URL("..", import.meta.url), stdio: "ignore" });
    await once(projectionChild, "exit");
    expect((await filesUnder(directory)).some((path) => /[/\\]\.tmp-/.test(path))).toBe(true);
    const repaired = await MarkdownTransactionalNamedMemoryDriver.open({ root: directory });
    const state = JSON.parse(await readFile(join(directory, ".agape-memory-v1", "state.json"), "utf8"));
    const operationId = state.payload.snapshot.operations[0].operationId as string;
    await repaired.status(operationId);
    await repaired.close();
    expect((await filesUnder(directory)).some((path) => /[/\\]\.tmp-/.test(path))).toBe(false);
  });

  it("rejects an unavailable identity placeholder before any canonical mutation", async () => {
    const directory = await root();
    const driver = await MarkdownTransactionalNamedMemoryDriver.open({
      root: directory, pathTemplate: "{user}/{mem}",
    });
    const projectOnly: ResolvedMemoryDescriptor = {
      ...descriptor(), scopes: ["project"],
    };
    const statePath = join(directory, ".agape-memory-v1", "state.json");
    const before = JSON.parse(await readFile(statePath, "utf8"));
    await expect(driver.prepareStore({
      ...context(projectOnly),
      value: { kind: "text", v: "must not stage", trust: "raw" },
    })).rejects.toThrow(/placeholder.*user|user.*unavailable/i);
    const after = JSON.parse(await readFile(statePath, "utf8"));
    expect(after.payload.revision).toBe(before.payload.revision);
    expect(after.payload.pending).toEqual([]);
    expect(after.payload.snapshot.operations).toEqual([]);
    expect((await filesUnder(directory)).some((path) => path.endsWith("MEMORY.md"))).toBe(false);
    await driver.close();
  });
});
