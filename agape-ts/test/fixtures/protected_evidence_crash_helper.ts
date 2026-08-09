import {
  FileProtectedEvidenceStore,
  ProtectedEvidenceError,
  type ProtectedEvidenceRequest,
} from "../../src/protected_evidence.js";

interface Config {
  mode: "delete-crash" | "inspect";
  root: string;
  keyHex: string;
  principal: string;
  request: ProtectedEvidenceRequest;
}

const encoded = process.env.AGAPE_P16_CRASH_HELPER;
if (!encoded) throw new Error("AGAPE_P16_CRASH_HELPER is required");
const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Config;
const store = await FileProtectedEvidenceStore.open({
  root: config.root,
  key: Buffer.from(config.keyHex, "hex"),
  authenticatedPrincipal: config.principal,
  ...(config.mode === "delete-crash" ? { afterDeletionMarker: () => process.exit(86) } : {}),
});

if (config.mode === "delete-crash") {
  await store.delete(config.request);
  process.exit(87);
}
try {
  await store.inspect(config.request);
  process.exitCode = 2;
} catch (error) {
  if (error instanceof ProtectedEvidenceError && error.code === "EvidenceUnavailable") process.exitCode = 0;
  else {
    process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 3;
  }
} finally {
  await store.close();
}
