import {
  removePlaidItem,
  safeErrorMessage,
  type PlaidRemoveClient,
} from "./plaid-client";
import { TokenStoreWriteIndeterminateError, type OrphanedItemRecord, type StoredItem, type TokenData, type TokenStore } from "./token-store";

interface PlaidExchangeClient extends PlaidRemoveClient {
  itemPublicTokenExchange(request: { public_token: string }): Promise<{
    data: { access_token: string; item_id: string };
  }>;
}

interface SetupLogger {
  error(message: string, details?: Record<string, unknown>): void;
}

export interface SetupHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ExchangeBody {
  public_token: string;
  institution_name: string;
  accounts: Array<{ id: string; name: string; type: string }>;
}

export interface DisconnectBody {
  item_id: string;
}

export async function handleCreateLinkToken(deps: {
  store: Pick<TokenStore, "assertWritable">;
  createLinkToken: () => Promise<string>;
  logger?: SetupLogger;
}): Promise<SetupHandlerResult> {
  try {
    await deps.store.assertWritable();
  } catch (e: unknown) {
    const error = safeErrorMessage(e);
    deps.logger?.error("Token storage is not writable", { error });
    return {
      status: 503,
      body: {
        ok: false,
        error: "Token storage is not writable. Fix storage before linking a Plaid account.",
        details: error,
      },
    };
  }

  try {
    const linkToken = await deps.createLinkToken();
    return { status: 200, body: { ok: true, linkToken } };
  } catch (e: unknown) {
    const error = safeErrorMessage(e);
    deps.logger?.error("Failed to create Plaid Link token", { error });
    return {
      status: 500,
      body: { ok: false, error: "Failed to create Plaid Link token.", details: error },
    };
  }
}

// Update-mode link token: repairs an existing (broken) Item in place rather
// than creating a new connection. Used to clear ITEM_LOGIN_REQUIRED.
export async function handleUpdateLinkToken(
  body: { item_id: string },
  deps: {
    store: Pick<TokenStore, "loadTokens">;
    createUpdateLinkToken: (accessToken: string) => Promise<string>;
    logger?: SetupLogger;
  },
): Promise<SetupHandlerResult> {
  let data: TokenData;
  try {
    data = deps.store.loadTokens();
  } catch (e: unknown) {
    deps.logger?.error("Could not load local token store for update link token", { error: safeErrorMessage(e) });
    return { status: 500, body: { ok: false, error: "Could not load local token store." } };
  }

  const item = data.items.find((i) => i.itemId === body.item_id);
  if (!item) {
    return { status: 404, body: { ok: false, error: "No local token was found for this item_id." } };
  }

  try {
    const linkToken = await deps.createUpdateLinkToken(item.accessToken);
    return { status: 200, body: { ok: true, linkToken } };
  } catch (e: unknown) {
    const error = safeErrorMessage(e);
    deps.logger?.error("Failed to create update-mode Plaid Link token", { error });
    return { status: 500, body: { ok: false, error: "Failed to create update-mode Plaid Link token.", details: error } };
  }
}

interface PlaidItemGetClient {
  itemGet(request: { access_token: string }): Promise<{
    data: { item: { error: { error_code?: string } | null } };
  }>;
}

// After update-mode Link succeeds, confirm the Item is actually healthy before
// clearing the UI's reauth flag. onHealthy runs only when Plaid reports no error.
export async function handleReconnectComplete(
  body: { item_id: string },
  deps: {
    client: PlaidItemGetClient;
    store: Pick<TokenStore, "loadTokens">;
    onHealthy: (item_id: string) => void;
    logger?: SetupLogger;
  },
): Promise<SetupHandlerResult> {
  let data: TokenData;
  try {
    data = deps.store.loadTokens();
  } catch (e: unknown) {
    deps.logger?.error("Could not load local token store for reconnect", { error: safeErrorMessage(e) });
    return { status: 500, body: { ok: false, error: "Could not load local token store." } };
  }

  const item = data.items.find((i) => i.itemId === body.item_id);
  if (!item) {
    return { status: 404, body: { ok: false, error: "No local token was found for this item_id." } };
  }

  let itemError: { error_code?: string } | null;
  try {
    const resp = await deps.client.itemGet({ access_token: item.accessToken });
    itemError = resp.data.item.error;
  } catch (e: unknown) {
    deps.logger?.error("Reconnect health check failed", { error: safeErrorMessage(e) });
    return { status: 502, body: { ok: false, error: "Could not verify Item health with Plaid." } };
  }

  if (itemError) {
    return { status: 200, body: { ok: true, healthy: false, errorCode: itemError.error_code ?? "UNKNOWN" } };
  }

  deps.onHealthy(body.item_id);
  return { status: 200, body: { ok: true, healthy: true } };
}

export async function handleExchange(
  body: ExchangeBody,
  deps: {
    client: PlaidExchangeClient;
    store: Pick<TokenStore, "addItem" | "recordOrphanedItem">;
    logger?: SetupLogger;
    now?: () => Date;
  },
): Promise<SetupHandlerResult> {
  let exchanged: { data: { access_token: string; item_id: string } };
  try {
    exchanged = await deps.client.itemPublicTokenExchange({ public_token: body.public_token });
  } catch (e: unknown) {
    const error = safeErrorMessage(e);
    deps.logger?.error("Plaid token exchange failed", { error });
    return {
      status: 502,
      body: { ok: false, error: "Plaid token exchange failed. No local token was saved.", details: error },
    };
  }

  const accessToken = exchanged.data.access_token;
  const itemId = exchanged.data.item_id;
  const connectedAt = (deps.now?.() ?? new Date()).toISOString();
  const item: StoredItem = {
    accessToken,
    itemId,
    institutionName: body.institution_name,
    accounts: body.accounts,
    connectedAt,
  };

  try {
    await deps.store.addItem(item);
    return { status: 200, body: { ok: true } };
  } catch (saveError: unknown) {
    const saveErrorText = safeErrorMessage(saveError);
    if (saveError instanceof TokenStoreWriteIndeterminateError) {
      const orphanRecord: OrphanedItemRecord = {
        itemId,
        institutionName: body.institution_name,
        createdAt: connectedAt,
        reason: "Plaid token exchange succeeded and local token write may have succeeded, but write verification failed. Automatic Plaid cleanup was not attempted.",
        error: saveErrorText,
      };

      try {
        const orphanRecordPath = await deps.store.recordOrphanedItem(orphanRecord);
        deps.logger?.error("Plaid item save verification failed; cleanup revoke skipped", {
          itemId,
          institutionName: body.institution_name,
          orphanRecordPath,
          saveError: saveErrorText,
        });
        return {
          status: 500,
          body: {
            ok: false,
            error: "Account setup could not verify local token storage. The Plaid connection was not automatically revoked because the token may have been saved.",
            itemId,
            orphanRecordPath,
          },
        };
      } catch (recordError: unknown) {
        deps.logger?.error("Plaid item save verification failed and emergency recording failed", {
          itemId,
          institutionName: body.institution_name,
          saveError: saveErrorText,
          recordError: safeErrorMessage(recordError),
        });
        return {
          status: 500,
          body: {
            ok: false,
            error: "Account setup could not verify local token storage. The Plaid connection was not automatically revoked, and emergency recording failed.",
            itemId,
          },
        };
      }
    }

    const revokeResult = await removePlaidItem(deps.client, accessToken);

    if (revokeResult.status !== "retryable") {
      deps.logger?.error("Plaid item save failed; fresh item was revoked", {
        itemId,
        institutionName: body.institution_name,
        saveError: saveErrorText,
        revokeStatus: revokeResult.status,
        ...(revokeResult.status === "terminal" ? { revokeErrorCode: revokeResult.errorCode } : {}),
      });
      return {
        status: 500,
        body: {
          ok: false,
          error: "Account setup failed. The new Plaid connection was revoked; please try again.",
        },
      };
    }

    const orphanRecord: OrphanedItemRecord = {
      itemId,
      institutionName: body.institution_name,
      createdAt: connectedAt,
      reason: "Plaid token exchange succeeded, local token save failed, and automatic Plaid cleanup failed.",
      error: saveErrorText,
      revokeError: revokeResult.error,
    };

    try {
      const orphanRecordPath = await deps.store.recordOrphanedItem(orphanRecord);
      deps.logger?.error("Plaid item save failed and cleanup revoke failed", {
        itemId,
        institutionName: body.institution_name,
        orphanRecordPath,
        saveError: saveErrorText,
        revokeError: revokeResult.error,
        ...(revokeResult.errorCode ? { revokeErrorCode: revokeResult.errorCode } : {}),
      });
      return {
        status: 500,
        body: {
          ok: false,
          error: "Account setup failed after Plaid linked the Item. Automatic cleanup also failed.",
          itemId,
          orphanRecordPath,
        },
      };
    } catch (recordError: unknown) {
      deps.logger?.error("Plaid item save failed, cleanup revoke failed, and orphan record failed", {
        itemId,
        institutionName: body.institution_name,
        saveError: saveErrorText,
        revokeError: revokeResult.error,
        recordError: safeErrorMessage(recordError),
      });
      return {
        status: 500,
        body: {
          ok: false,
          error: "Account setup failed after Plaid linked the Item. Automatic cleanup and emergency recording both failed.",
          itemId,
        },
      };
    }
  }
}

export async function handleDisconnect(
  body: DisconnectBody,
  deps: {
    client: PlaidRemoveClient;
    store: Pick<TokenStore, "loadTokens" | "removeItem">;
    logger?: SetupLogger;
  },
): Promise<SetupHandlerResult> {
  let data: ReturnType<TokenStore["loadTokens"]>;
  try {
    data = deps.store.loadTokens();
  } catch (e: unknown) {
    const error = safeErrorMessage(e);
    deps.logger?.error("Could not load local token store for disconnect", { error });
    return {
      status: 500,
      body: {
        ok: false,
        error: "Could not load local token store. Plaid revocation was not attempted.",
      },
    };
  }

  const item = data.items.find((i) => i.itemId === body.item_id);
  if (!item) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "No local token was found for this item_id, so Plaid access could not be revoked from this app.",
      },
    };
  }

  const revokeResult = await removePlaidItem(deps.client, item.accessToken);
  if (revokeResult.status === "retryable") {
    deps.logger?.error("Plaid revocation failed; local token retained", {
      itemId: body.item_id,
      institutionName: item.institutionName,
      revokeError: revokeResult.error,
      ...(revokeResult.errorCode ? { revokeErrorCode: revokeResult.errorCode } : {}),
    });
    return {
      status: 502,
      body: {
        ok: false,
        error: "Plaid revocation failed. Local token was retained so you can retry disconnect.",
      },
    };
  }

  try {
    const removed = await deps.store.removeItem(body.item_id);
    if (!removed) {
      return {
        status: 500,
        body: {
          ok: false,
          error: "Plaid access was revoked, but local token cleanup did not remove a record.",
        },
      };
    }
  } catch (e: unknown) {
    deps.logger?.error("Plaid access was revoked, but local token cleanup failed", {
      itemId: body.item_id,
      error: safeErrorMessage(e),
    });
    return {
      status: 500,
      body: {
        ok: false,
        error: "Plaid access was revoked, but local token cleanup failed. Retry local cleanup.",
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      revoked: revokeResult.status === "revoked",
      ...(revokeResult.status === "terminal" ? { terminalCode: revokeResult.errorCode } : {}),
    },
  };
}

export type { PlaidExchangeClient, SetupLogger };
