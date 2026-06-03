import { describe, test, expect } from "bun:test";
import { handleUpdateLinkToken, handleReconnectComplete } from "../setup-handlers";

const ITEM = {
  accessToken: "access-production-abc",
  itemId: "item-123",
  institutionName: "B&H Payboo Credit Card",
  accounts: [{ id: "a1", name: "B&H", type: "credit" }],
  connectedAt: "2026-05-28T00:00:00.000Z",
};
const store = { loadTokens: () => ({ items: [ITEM] }) };

describe("handleUpdateLinkToken", () => {
  test("creates an update-mode link token for the item's access token", async () => {
    let seenToken: string | null = null;
    const res = await handleUpdateLinkToken(
      { item_id: "item-123" },
      {
        store,
        createUpdateLinkToken: async (accessToken) => {
          seenToken = accessToken;
          return "link-update-xyz";
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, linkToken: "link-update-xyz" });
    expect(seenToken).toBe("access-production-abc");
  });

  test("unknown item_id → 404, link token never created", async () => {
    let called = false;
    const res = await handleUpdateLinkToken(
      { item_id: "nope" },
      { store, createUpdateLinkToken: async () => { called = true; return "x"; } },
    );
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("Plaid error → 500", async () => {
    const res = await handleUpdateLinkToken(
      { item_id: "item-123" },
      { store, createUpdateLinkToken: async () => { throw new Error("plaid down"); } },
    );
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe("handleReconnectComplete", () => {
  function clientWithError(error: unknown) {
    return { itemGet: async (_req: { access_token: string }) => ({ data: { item: { error } } }) };
  }

  test("item healthy (error null) → marks healthy via onHealthy", async () => {
    const healed: string[] = [];
    const res = await handleReconnectComplete(
      { item_id: "item-123" },
      { store, client: clientWithError(null), onHealthy: (id) => healed.push(id) },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, healthy: true });
    expect(healed).toEqual(["item-123"]);
  });

  test("item still broken → healthy false, onHealthy NOT called", async () => {
    const healed: string[] = [];
    const res = await handleReconnectComplete(
      { item_id: "item-123" },
      {
        store,
        client: clientWithError({ error_code: "ITEM_LOGIN_REQUIRED" }),
        onHealthy: (id) => healed.push(id),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.healthy).toBe(false);
    expect(res.body.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(healed).toEqual([]);
  });

  test("unknown item_id → 404", async () => {
    const res = await handleReconnectComplete(
      { item_id: "nope" },
      { store, client: clientWithError(null), onHealthy: () => {} },
    );
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
