#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPlaidClient, resolvePlaidEnv } from "./plaid-client";
import { getAccessTokens, loadTokens } from "./token-store";

const env = resolvePlaidEnv();
const client = createPlaidClient(env);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeError(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message;
    return msg.replace(/access-[a-z]+-[a-f0-9-]+/gi, "[REDACTED]").replace(/secret_[a-zA-Z0-9]+/g, "[REDACTED]");
  }
  return "Unknown error";
}

const server = new McpServer({
  name: "plaid-mcp",
  version: "0.1.0",
});

// ── list_accounts ──────────────────────────────────────────────────────────

server.tool(
  "list_accounts",
  "List all connected financial accounts with balances",
  {},
  async () => {
    const tokens = getAccessTokens();
    if (tokens.length === 0) {
      return { content: [{ type: "text", text: "No accounts connected. Run `plaid-mcp-setup` to link accounts." }] };
    }

    const results = [];
    for (const token of tokens) {
      try {
        const response = await client.accountsGet({ access_token: token.accessToken });
        for (const acct of response.data.accounts) {
          results.push({
            institution: token.institutionName,
            name: acct.name,
            officialName: acct.official_name,
            type: acct.type,
            subtype: acct.subtype,
            balance: acct.balances.current,
            available: acct.balances.available,
            currency: acct.balances.iso_currency_code,
            accountId: acct.account_id,
          });
        }
      } catch (e: unknown) {
        results.push({ institution: token.institutionName, error: safeError(e) });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },
);

// ── get_balances ───────────────────────────────────────────────────────────

server.tool(
  "get_balances",
  "Get current balances for all connected accounts",
  {},
  async () => {
    const tokens = getAccessTokens();
    if (tokens.length === 0) {
      return { content: [{ type: "text", text: "No accounts connected." }] };
    }

    const results = [];
    for (const token of tokens) {
      try {
        const response = await client.accountsGet({ access_token: token.accessToken });
        for (const acct of response.data.accounts) {
          results.push({
            institution: token.institutionName,
            account: acct.name,
            type: acct.type,
            current: acct.balances.current,
            available: acct.balances.available,
            limit: acct.balances.limit,
            currency: acct.balances.iso_currency_code,
          });
        }
      } catch (e: unknown) {
        results.push({ institution: token.institutionName, error: safeError(e) });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },
);

// ── get_transactions ───────────────────────────────────────────────────────

server.tool(
  "get_transactions",
  "Get transactions for a date range. Dates in YYYY-MM-DD format.",
  {
    start_date: z.string().describe("Start date (YYYY-MM-DD)"),
    end_date: z.string().describe("End date (YYYY-MM-DD)"),
    account_id: z.string().optional().describe("Filter to a specific account ID"),
    count: z.number().int().min(1).max(500).optional().default(100).describe("Max transactions per institution (default 100, max 500)"),
  },
  async ({ start_date, end_date, account_id, count }) => {
    if (!DATE_RE.test(start_date) || !DATE_RE.test(end_date)) {
      return { content: [{ type: "text", text: "Invalid date format. Use YYYY-MM-DD." }] };
    }
    const tokens = getAccessTokens();
    if (tokens.length === 0) {
      return { content: [{ type: "text", text: "No accounts connected." }] };
    }

    const perInstitutionLimit = count ?? 100;
    const allTransactions = [];
    const errors = [];

    for (const token of tokens) {
      try {
        let offset = 0;
        let total = Infinity;
        let institutionCount = 0;
        while (offset < total && institutionCount < perInstitutionLimit) {
          const response = await client.transactionsGet({
            access_token: token.accessToken,
            start_date,
            end_date,
            options: {
              count: Math.min(100, perInstitutionLimit - institutionCount),
              offset,
              ...(account_id ? { account_ids: [account_id] } : {}),
            },
          });
          total = response.data.total_transactions;
          if (response.data.transactions.length === 0) break;
          for (const txn of response.data.transactions) {
            allTransactions.push({
              date: txn.date,
              name: txn.name,
              merchantName: txn.merchant_name,
              amount: txn.amount,
              currency: txn.iso_currency_code,
              category: txn.personal_finance_category?.primary,
              subcategory: txn.personal_finance_category?.detailed,
              pending: txn.pending,
              accountId: txn.account_id,
              transactionId: txn.transaction_id,
              institution: token.institutionName,
            });
            institutionCount++;
          }
          offset += response.data.transactions.length;
        }
      } catch (e: unknown) {
        errors.push({ institution: token.institutionName, error: safeError(e) });
      }
    }

    const result = { transactions: allTransactions, ...(errors.length > 0 ? { errors } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── get_recurring_transactions ─────────────────────────────────────────────

server.tool(
  "get_recurring_transactions",
  "Get recurring/subscription transactions (bills, subscriptions, etc.)",
  {},
  async () => {
    const tokens = getAccessTokens();
    if (tokens.length === 0) {
      return { content: [{ type: "text", text: "No accounts connected." }] };
    }

    const results = [];
    for (const token of tokens) {
      try {
        const acctResp = await client.accountsGet({ access_token: token.accessToken });
        const accountIds = acctResp.data.accounts.map((a) => a.account_id);

        const response = await client.transactionsRecurringGet({
          access_token: token.accessToken,
          account_ids: accountIds,
        });

        for (const stream of [...response.data.inflow_streams, ...response.data.outflow_streams]) {
          results.push({
            institution: token.institutionName,
            description: stream.description,
            merchantName: stream.merchant_name,
            amount: stream.average_amount?.amount,
            frequency: stream.frequency,
            category: stream.personal_finance_category?.primary,
            lastDate: stream.last_date,
            nextDate: stream.predicted_next_date,
            active: stream.is_active,
            direction: response.data.inflow_streams.includes(stream) ? "inflow" : "outflow",
          });
        }
      } catch (e: unknown) {
        results.push({ institution: token.institutionName, error: safeError(e) });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },
);

// ── get_investments ────────────────────────────────────────────────────────

server.tool(
  "get_investments",
  "Get investment holdings (stocks, ETFs, mutual funds, etc.)",
  {},
  async () => {
    const tokens = getAccessTokens();
    if (tokens.length === 0) {
      return { content: [{ type: "text", text: "No accounts connected." }] };
    }

    const results = [];
    for (const token of tokens) {
      try {
        const response = await client.investmentsHoldingsGet({
          access_token: token.accessToken,
        });

        const securitiesMap = new Map(
          response.data.securities.map((s) => [s.security_id, s]),
        );

        for (const holding of response.data.holdings) {
          const security = securitiesMap.get(holding.security_id);
          results.push({
            institution: token.institutionName,
            accountId: holding.account_id,
            name: security?.name,
            ticker: security?.ticker_symbol,
            type: security?.type,
            quantity: holding.quantity,
            price: holding.institution_price,
            value: holding.institution_value,
            costBasis: holding.cost_basis,
            currency: holding.iso_currency_code,
          });
        }
      } catch (e: unknown) {
        const msg = safeError(e);
        if (!msg.includes("PRODUCTS_NOT_SUPPORTED") && !msg.includes("NO_INVESTMENT_ACCOUNTS")) {
          results.push({ institution: token.institutionName, error: msg });
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No investment accounts found across connected institutions." }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },
);

// ── get_liabilities ────────────────────────────────────────────────────────

server.tool(
  "get_liabilities",
  "Get liabilities (credit cards, student loans, mortgages)",
  {},
  async () => {
    const tokens = getAccessTokens();
    if (tokens.length === 0) {
      return { content: [{ type: "text", text: "No accounts connected." }] };
    }

    const results = [];
    for (const token of tokens) {
      try {
        const response = await client.liabilitiesGet({
          access_token: token.accessToken,
        });

        const liabilities = response.data.liabilities;

        if (liabilities.credit) {
          for (const cc of liabilities.credit) {
            results.push({
              institution: token.institutionName,
              type: "credit_card",
              accountId: cc.account_id,
              lastPaymentAmount: cc.last_payment_amount,
              lastPaymentDate: cc.last_payment_date,
              lastStatementBalance: cc.last_statement_balance,
              minimumPayment: cc.minimum_payment_amount,
              nextPaymentDue: cc.next_payment_due_date,
              aprs: cc.aprs?.map((a) => ({ type: a.apr_type, rate: a.apr_percentage })),
            });
          }
        }

        if (liabilities.student) {
          for (const loan of liabilities.student) {
            results.push({
              institution: token.institutionName,
              type: "student_loan",
              accountId: loan.account_id,
              originationPrincipal: loan.origination_principal_amount,
              outstandingBalance: loan.outstanding_interest_amount,
              interestRate: loan.interest_rate_percentage,
              nextPaymentDue: loan.next_payment_due_date,
              expectedPayoff: loan.expected_payoff_date,
            });
          }
        }

        if (liabilities.mortgage) {
          for (const mort of liabilities.mortgage) {
            results.push({
              institution: token.institutionName,
              type: "mortgage",
              accountId: mort.account_id,
              interestRate: mort.interest_rate?.percentage,
              lastPaymentAmount: mort.last_payment_amount,
              lastPaymentDate: mort.last_payment_date,
              nextPaymentDue: mort.next_payment_due_date,
              originationPrincipal: mort.origination_principal_amount,
              maturityDate: mort.maturity_date,
            });
          }
        }
      } catch (e: unknown) {
        const msg = safeError(e);
        if (!msg.includes("PRODUCTS_NOT_SUPPORTED") && !msg.includes("NO_LIABILITY_ACCOUNTS")) {
          results.push({ institution: token.institutionName, error: msg });
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No liability accounts found across connected institutions." }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },
);

// ── connection_status ──────────────────────────────────────────────────────

server.tool(
  "connection_status",
  "Show which institutions and accounts are currently connected",
  {},
  async () => {
    const data = loadTokens();
    if (data.items.length === 0) {
      return { content: [{ type: "text", text: "No accounts connected. Run `plaid-mcp-setup` to link accounts." }] };
    }

    const summary = data.items.map((item) => ({
      institution: item.institutionName,
      connectedAt: item.connectedAt,
      accounts: item.accounts.map((a) => ({ name: a.name, type: a.type })),
    }));

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  },
);

// ── start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("plaid-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
