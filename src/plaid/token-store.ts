import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

const OP_VAULT = "Plaid";
const OP_ITEM = "plaid-mcp-tokens";
const OP_WRITE_PROBE_ITEM = "plaid-mcp-write-probe";
const CONFIG_DIR = join(homedir(), ".config", "plaid-mcp");
const LOCAL_FALLBACK_PATH = join(CONFIG_DIR, "tokens.json");
const ORPHANED_ITEMS_PATH = join(CONFIG_DIR, "orphaned-items.jsonl");

interface StoredItem {
  accessToken: string;
  itemId: string;
  institutionName: string;
  accounts: Array<{ id: string; name: string; type: string }>;
  connectedAt: string;
}

interface TokenData {
  items: StoredItem[];
}

interface OrphanedItemRecord {
  itemId: string;
  institutionName: string;
  createdAt: string;
  reason: string;
  error?: string;
  revokeError?: string;
}

interface TokenStore {
  loadTokens(): TokenData;
  addItem(item: StoredItem): Promise<void>;
  removeItem(itemId: string): Promise<boolean>;
  assertWritable(): Promise<void>;
  recordOrphanedItem(record: OrphanedItemRecord): Promise<string>;
}

interface OnePasswordField {
  id?: string;
  title?: string;
  fieldType?: unknown;
  value?: string;
  purpose?: string;
}

interface OnePasswordItemOverview {
  id: string;
  title: string;
}

interface OnePasswordItem extends OnePasswordItemOverview {
  fields?: OnePasswordField[];
}

interface OnePasswordClientLike {
  vaults: {
    list(): Promise<Array<{ id: string; title?: string; name?: string }>>;
  };
  items: {
    list(vaultId: string): Promise<OnePasswordItemOverview[]>;
    get(vaultId: string, itemId: string): Promise<OnePasswordItem>;
    put(item: OnePasswordItem): Promise<OnePasswordItem>;
    create(params: {
      title: string;
      category: unknown;
      vaultId: string;
      fields: OnePasswordField[];
    }): Promise<OnePasswordItem>;
  };
}

export class TokenStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TokenStoreError";
  }
}

export class TokenStoreWriteIndeterminateError extends TokenStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "TokenStoreWriteIndeterminateError";
  }
}

function hasOp(): boolean {
  try {
    execFileSync("op", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function tokenDataFromFields(fields: OnePasswordField[] | undefined): TokenData {
  for (const field of fields ?? []) {
    if (field.id === "notesPlain" || field.purpose === "NOTES") {
      const val = field.value ?? "";
      if (val && val !== "-") {
        return JSON.parse(val) as TokenData;
      }
    }
  }
  return { items: [] };
}

function opRead(): TokenData {
  let result: string;
  try {
    result = execFileSync(
      "op",
      ["item", "get", OP_ITEM, "--vault", OP_VAULT, "--format", "json", "--reveal"],
      { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found") || msg.includes("isn't an item")) {
      return { items: [] };
    }
    throw new TokenStoreError("Failed to read from 1Password", e);
  }
  const item = JSON.parse(result) as { fields?: OnePasswordField[] };
  return tokenDataFromFields(item.fields);
}

async function createOpSdkClient(): Promise<{
  client: OnePasswordClientLike;
  itemCategorySecureNote: unknown;
  itemFieldTypeText: unknown;
}> {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    throw new TokenStoreError("OP_SERVICE_ACCOUNT_TOKEN required for writing to 1Password");
  }

  const { createClient, ItemCategory, ItemFieldType } = await import("@1password/sdk");
  const client = await createClient({
    auth: token,
    integrationName: "plaid-mcp",
    integrationVersion: "0.1.0",
  });

  return {
    client: client as OnePasswordClientLike,
    itemCategorySecureNote: ItemCategory.SecureNote,
    itemFieldTypeText: ItemFieldType.Text,
  };
}

async function opWriteSDK(data: TokenData): Promise<void> {
  const { client, itemCategorySecureNote, itemFieldTypeText } = await createOpSdkClient();
  await writeTokensToOnePassword(client, data, itemCategorySecureNote, itemFieldTypeText);
}

export async function writeTokensToOnePassword(
  client: OnePasswordClientLike,
  data: TokenData,
  itemCategorySecureNote: unknown = "SecureNote",
  itemFieldTypeText: unknown = "Text",
): Promise<void> {
  const json = JSON.stringify(data);
  let vaultId: string;
  let writtenItemId: string;

  try {
    vaultId = await resolveVaultId(client, OP_VAULT);
    const existing = await findItem(client, vaultId, OP_ITEM);
    if (existing) {
      const full = await client.items.get(vaultId, existing.id);
      upsertNotesPlainField(full, json, itemFieldTypeText);
      await client.items.put(full);
      writtenItemId = existing.id;
    } else {
      const created = await client.items.create({
        title: OP_ITEM,
        category: itemCategorySecureNote,
        vaultId,
        fields: [
          { id: "notesPlain", title: "notesPlain", fieldType: itemFieldTypeText, value: json },
        ],
      });
      writtenItemId = created.id;
    }
  } catch (e: unknown) {
    throw new TokenStoreError("Failed to write to 1Password via SDK", e);
  }

  try {
    await verifyOnePasswordWrite(client, vaultId, writtenItemId, data);
  } catch (e: unknown) {
    throw new TokenStoreWriteIndeterminateError("1Password write completed but verification failed", e);
  }
}

export async function assertOnePasswordWritable(
  client: OnePasswordClientLike,
  itemCategorySecureNote: unknown = "SecureNote",
  itemFieldTypeText: unknown = "Text",
): Promise<void> {
  try {
    const vaultId = await resolveVaultId(client, OP_VAULT);
    const existingProbeItem = await findItem(client, vaultId, OP_WRITE_PROBE_ITEM);
    const probeValue = JSON.stringify({ checkedAt: new Date().toISOString(), purpose: "plaid-mcp write preflight" });
    if (existingProbeItem) {
      const full = await client.items.get(vaultId, existingProbeItem.id);
      upsertNotesPlainField(full, probeValue, itemFieldTypeText);
      await client.items.put(full);
      return;
    }

    await client.items.create({
      title: OP_WRITE_PROBE_ITEM,
      category: itemCategorySecureNote,
      vaultId,
      fields: [
        { id: "notesPlain", title: "notesPlain", fieldType: itemFieldTypeText, value: probeValue },
      ],
    });
  } catch (e: unknown) {
    throw new TokenStoreError("1Password write preflight failed", e);
  }
}

async function resolveVaultId(client: OnePasswordClientLike, vaultName: string): Promise<string> {
  const vaults = await client.vaults.list();
  for (const vault of vaults) {
    if (vault.title === vaultName || vault.name === vaultName || vault.id === vaultName) return vault.id;
  }
  throw new TokenStoreError(`Vault "${vaultName}" not found`);
}

async function findItem(client: OnePasswordClientLike, vaultId: string, title: string): Promise<OnePasswordItemOverview | null> {
  const items = await client.items.list(vaultId);
  const matches = items.filter((item) => item.title === title);
  if (matches.length > 1) {
    throw new TokenStoreError(`Multiple 1Password items named "${title}" found; clean up duplicates before writing`);
  }
  return matches[0] ?? null;
}

function upsertNotesPlainField(item: OnePasswordItem, value: string, itemFieldTypeText: unknown): void {
  item.fields ??= [];
  const existing = item.fields.find((field) => field.id === "notesPlain" || field.purpose === "NOTES");
  if (existing) {
    existing.id = existing.id ?? "notesPlain";
    existing.title = existing.title ?? "notesPlain";
    existing.fieldType = existing.fieldType ?? itemFieldTypeText;
    existing.value = value;
    return;
  }
  item.fields.push({ id: "notesPlain", title: "notesPlain", fieldType: itemFieldTypeText, value });
}

async function verifyOnePasswordWrite(
  client: OnePasswordClientLike,
  vaultId: string,
  itemId: string,
  expected: TokenData,
): Promise<void> {
  const written = await client.items.get(vaultId, itemId);
  const actual = tokenDataFromFields(written.fields);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new TokenStoreError("1Password write verification failed");
  }
}

function localRead(): TokenData {
  if (!existsSync(LOCAL_FALLBACK_PATH)) return { items: [] };
  try {
    const raw = readFileSync(LOCAL_FALLBACK_PATH, "utf8");
    return JSON.parse(raw) as TokenData;
  } catch (e: unknown) {
    throw new TokenStoreError("Failed to read local token file (corrupt?)", e);
  }
}

function localWrite(data: TokenData): void {
  ensureConfigDir();
  const tmpPath = LOCAL_FALLBACK_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmpPath, LOCAL_FALLBACK_PATH);
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function localAssertWritable(): void {
  ensureConfigDir();
  const tmpPath = join(CONFIG_DIR, `.write-test-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmpPath, "", { mode: 0o600, flag: "wx" });
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

const useOp = hasOp();

export function loadTokens(): TokenData {
  return useOp ? opRead() : localRead();
}

// Refuse to persist Plaid access tokens as plaintext unless explicitly opted in.
// Without the 1Password CLI, the only sink is a cleartext JSON file holding
// replayable production bank credentials — make that a deliberate choice, not a
// silent fallback. Pure + injectable env so it is unit-testable.
export function assertPlaintextFallbackAllowed(
  path: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.PLAID_ALLOW_PLAINTEXT_FALLBACK !== "1") {
    throw new TokenStoreError(
      `Refusing to write Plaid access tokens as plaintext to ${path}. ` +
      `The 1Password CLI ("op") was not found, so secure storage is unavailable. ` +
      `Set PLAID_ALLOW_PLAINTEXT_FALLBACK=1 to allow plaintext fallback (NOT recommended).`,
    );
  }
}

export async function saveTokens(data: TokenData): Promise<void> {
  if (useOp) {
    await opWriteSDK(data);
  } else {
    assertPlaintextFallbackAllowed(LOCAL_FALLBACK_PATH);
    console.warn(
      `[token-store] WARNING: writing Plaid access tokens as PLAINTEXT to ${LOCAL_FALLBACK_PATH} ` +
      `(PLAID_ALLOW_PLAINTEXT_FALLBACK=1). These are replayable production bank credentials.`,
    );
    localWrite(data);
  }
}

export async function addItem(item: StoredItem): Promise<void> {
  const data = loadTokens();
  const existing = data.items.findIndex((i) => i.itemId === item.itemId);
  if (existing >= 0) {
    data.items[existing] = item;
  } else {
    data.items.push(item);
  }
  await saveTokens(data);
}

export async function removeItem(itemId: string): Promise<boolean> {
  const data = loadTokens();
  const before = data.items.length;
  data.items = data.items.filter((i) => i.itemId !== itemId);
  if (data.items.length < before) {
    await saveTokens(data);
    return true;
  }
  return false;
}

export async function assertWritable(): Promise<void> {
  if (useOp) {
    const { client, itemCategorySecureNote, itemFieldTypeText } = await createOpSdkClient();
    await assertOnePasswordWritable(client, itemCategorySecureNote, itemFieldTypeText);
    return;
  }
  localAssertWritable();
}

export async function recordOrphanedItem(record: OrphanedItemRecord): Promise<string> {
  ensureConfigDir();
  appendFileSync(ORPHANED_ITEMS_PATH, JSON.stringify(record) + "\n", { mode: 0o600 });
  chmodSync(ORPHANED_ITEMS_PATH, 0o600);
  return ORPHANED_ITEMS_PATH;
}

export function getAccessTokens(): Array<{ accessToken: string; itemId: string; institutionName: string }> {
  const data = loadTokens();
  return data.items.map((i) => ({
    accessToken: i.accessToken,
    itemId: i.itemId,
    institutionName: i.institutionName,
  }));
}

export function getStorageBackend(): string {
  return useOp ? "1Password" : "local file (no 1Password CLI detected)";
}

export const defaultTokenStore: TokenStore = {
  loadTokens,
  addItem,
  removeItem,
  assertWritable,
  recordOrphanedItem,
};

export type { OnePasswordClientLike, OrphanedItemRecord, StoredItem, TokenData, TokenStore };
