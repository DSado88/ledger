use rust_mcp_sdk::macros::{JsonSchema, mcp_tool};
use rust_mcp_sdk::schema::{CallToolResult, TextContent, schema_utils::CallToolError};
use rust_mcp_sdk::tool_box;

use crate::client::{AmazonClient, AuthExpired, ORDER_HISTORY_URL};

#[derive(Debug)]
struct ToolErr(String);
impl std::fmt::Display for ToolErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ToolErr {}

fn err(e: anyhow::Error) -> CallToolError {
    // When the failure is an expired session, return a structured, actionable payload
    // so the caller knows to invoke amazon_login rather than improvising a browser flow.
    if e.chain().any(|c| c.is::<AuthExpired>()) {
        let payload = serde_json::json!({
            "error": "auth_expired",
            "action": "Amazon session expired. Call amazon_login to re-authenticate, then retry this tool.",
            "signin_url": ORDER_HISTORY_URL,
        });
        return CallToolError::new(ToolErr(payload.to_string()));
    }
    CallToolError::new(ToolErr(format!("{:#}", e)))
}

fn json_result<T: serde::Serialize>(val: &T) -> Result<CallToolResult, CallToolError> {
    let json = serde_json::to_string_pretty(val)
        .map_err(|e| CallToolError::new(ToolErr(e.to_string())))?;
    Ok(CallToolResult::text_content(vec![TextContent::from(json)]))
}

#[mcp_tool(
    name = "amazon_list_orders",
    description = "List Amazon physical orders. Returns order summaries with IDs, dates, totals, products, and delivery status. WARNING: The 'total' field is the order sticker price, NOT what was charged to the card -- gift cards, rewards, and S&S discounts can reduce the actual charge. Subscribe & Save orders are flagged via subscribe_and_save=true; these may charge days/weeks after the order date. Does NOT include digital orders (Music, Kindle) or Prime membership charges -- use the dedicated tools for those."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct ListOrdersTool {
    /// Time filter: "last30", "months-3", "year-2026", "year-2025", etc.
    #[serde(default = "default_filter")]
    filter: String,
    /// Number of pages to fetch (10 orders per page). 0 = all pages.
    #[serde(default = "default_pages")]
    pages: u32,
}

fn default_filter() -> String { "months-3".into() }
fn default_pages() -> u32 { 1 }

impl ListOrdersTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let max = if self.pages == 0 { usize::MAX } else { self.pages as usize };
        let orders = client.list_orders(&self.filter, max).await.map_err(err)?;
        json_result(&orders)
    }
}

#[mcp_tool(
    name = "amazon_list_digital_orders",
    description = "List Amazon digital orders (Music Unlimited, Kindle, Audible, Prime Video, app subscriptions). These charges do NOT appear in physical order history -- they are a separate billing system. Order IDs use D01- prefix. Chase labels these as 'Amazon Digit*'."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct ListDigitalOrdersTool {
    /// Time filter: "last30", "months-3", "year-2026", "year-2025", etc.
    #[serde(default = "default_filter")]
    filter: String,
    /// Number of pages to fetch (10 orders per page). 0 = all pages.
    #[serde(default = "default_pages")]
    pages: u32,
}

impl ListDigitalOrdersTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let max = if self.pages == 0 { usize::MAX } else { self.pages as usize };
        let orders = client.list_digital_orders(&self.filter, max).await.map_err(err)?;
        json_result(&orders)
    }
}

#[mcp_tool(
    name = "amazon_prime_payments",
    description = "Get Amazon Prime membership payment history. Returns all Prime renewal charges with dates, amounts, order numbers, and receipt URLs. These charges do NOT appear in regular or digital order history -- they are a third separate billing system. Chase labels these as 'Amazon Prime'. Order IDs use D01- prefix."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct PrimePaymentsTool {}

impl PrimePaymentsTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let payments = client.prime_payments().await.map_err(err)?;
        json_result(&payments)
    }
}

#[mcp_tool(
    name = "amazon_search_orders",
    description = "Search Amazon orders by charge amount. Returns orders within tolerance of the target amount, sorted by proximity. Results include subscribe_and_save flag. NOTE: This searches order LIST totals only, not invoice grand totals -- for charges reduced by gift cards or rewards, use amazon_reconcile_charge instead which pulls invoices and matches on the actual charged amount."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct SearchOrdersTool {
    /// Dollar amount to match, e.g. 42.74
    amount: f64,
    /// Match tolerance in dollars (default 1.00). Orders within this range of the target amount are returned.
    #[serde(default = "default_tolerance")]
    tolerance: f64,
    /// Time filter: "last30", "months-3", "year-2026", etc.
    #[serde(default = "default_search_filter")]
    filter: String,
}

fn default_tolerance() -> f64 { 1.0 }
fn default_search_filter() -> String { "months-3".into() }

impl SearchOrdersTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let orders = client.list_orders(&self.filter, 50).await.map_err(err)?;

        let mut matches: Vec<_> = orders
            .into_iter()
            .filter_map(|o| {
                let total_str = o.total.as_deref()?;
                let parsed = total_str
                    .trim_start_matches('$')
                    .replace(',', "")
                    .parse::<f64>()
                    .ok()?;
                let diff = (parsed - self.amount).abs();
                if diff <= self.tolerance {
                    Some((diff, o))
                } else {
                    None
                }
            })
            .collect();

        matches.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let results: Vec<_> = matches.into_iter().map(|(_, o)| o).collect();
        json_result(&results)
    }
}

#[mcp_tool(
    name = "amazon_invoice",
    description = "Get the invoice/financial summary for an Amazon order. Returns line items with prices, and financial breakdown as label/amount pairs. IMPORTANT: The 'Grand Total' row is what was charged to the card. Other rows (Gift Card Amount, Rewards Points, Subscribe & Save) explain the difference between Item(s) Subtotal and Grand Total. Do NOT assume Item(s) Subtotal = card charge."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct InvoiceTool {
    /// Order ID, e.g. "111-9870271-4101823"
    order_id: String,
}

impl InvoiceTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let invoice = client.invoice(&self.order_id).await.map_err(err)?;
        json_result(&invoice)
    }
}

#[mcp_tool(
    name = "amazon_order_details",
    description = "Get full details for an Amazon order including shipping address, payment info, shipments with tracking URLs, and item-level data."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct OrderDetailsTool {
    /// Order ID, e.g. "111-9870271-4101823"
    order_id: String,
}

impl OrderDetailsTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let details = client.order_details(&self.order_id).await.map_err(err)?;
        json_result(&details)
    }
}

#[mcp_tool(
    name = "amazon_track_package",
    description = "Get tracking info for an Amazon shipment. Returns carrier, tracking ID, delivery status, progress milestones, delivery photo URL, and tracking events timeline. Requires item_id and shipment_id from order details."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct TrackPackageTool {
    /// Order ID
    order_id: String,
    /// Item ID (from order details shipment actions)
    item_id: String,
    /// Shipment ID (from order details shipment actions)
    shipment_id: String,
}

impl TrackPackageTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let tracking = client.tracking(&self.order_id, &self.item_id, &self.shipment_id)
            .await.map_err(err)?;
        json_result(&tracking)
    }
}

#[mcp_tool(
    name = "amazon_dump_orders",
    description = "Dump all orders with invoices for a time period. Returns full order summaries and financial breakdowns. Can be slow for large ranges."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct DumpOrdersTool {
    /// Time filter: "last30", "months-3", "year-2026", etc.
    #[serde(default = "default_dump_filter")]
    filter: String,
}

fn default_max_candidates() -> u32 { 5 }

fn default_dump_filter() -> String { "months-3".into() }

impl DumpOrdersTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let dump = client.full_dump(&self.filter).await.map_err(err)?;
        json_result(&dump)
    }
}

#[mcp_tool(
    name = "amazon_reconcile_charge",
    description = "Reconcile a credit card charge against Amazon orders. This is the primary tool for 'what is this charge?' questions. Searches physical, digital, and Prime sources in parallel, pulls invoices for top candidates, and matches by invoice Grand Total (the actual card charge, not the order sticker price). Returns structured breakdown showing how subtotal was reduced by S&S discounts, coupons, gift cards, and rewards points. MATCH QUALITY GUIDE: ExactGrandTotal = high confidence match. ExactOrderTotal = amount matches but no invoice to confirm (common for digital/Prime). FuzzyGrandTotal = close but not exact, check the diff. NoInvoice = matched by order total only. GOTCHAS: (1) S&S orders can be 2-3 weeks older than the charge date. (2) Gift card orders will have order_total >> charge amount -- the tool includes these as offset candidates but they rank lower. If no ExactGrandTotal found, try increasing max_candidates. (3) Merchant name helps narrow scope: pass it when available to avoid searching all three billing systems."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct ReconcileChargeTool {
    /// Dollar amount from credit card statement, e.g. 42.74
    amount: f64,
    /// Date of the charge in YYYY-MM-DD format, e.g. "2026-05-03"
    charge_date: String,
    /// Merchant name from credit card statement, e.g. "AMZN MKTP US". Helps narrow search scope.
    #[serde(default)]
    merchant_name: Option<String>,
    /// Match tolerance in dollars (default 1.00)
    #[serde(default = "default_tolerance")]
    tolerance: f64,
    /// Max candidates to return with full invoice breakdowns (default 5)
    #[serde(default = "default_max_candidates")]
    max_candidates: u32,
}

impl ReconcileChargeTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let result = client
            .reconcile_charge(
                self.amount,
                &self.charge_date,
                self.merchant_name.as_deref(),
                self.tolerance,
                self.max_candidates as usize,
            )
            .await
            .map_err(err)?;
        json_result(&result)
    }
}

#[mcp_tool(
    name = "amazon_list_returns",
    description = "List Amazon returns and refunds from the last 90 days. Shows return status (Return complete, Refund issued), refund credit amount and date when available, item details, and order IDs. Use this to find refund amounts and dates for reconciling credit card refund credits."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct ListReturnsTool {}

impl ListReturnsTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let returns = client.list_returns().await.map_err(err)?;
        json_result(&returns)
    }
}

#[mcp_tool(
    name = "amazon_transactions",
    description = "Get payment transactions for an Amazon order. Shows each charge and refund posted to your card with dates and amounts. Charges appear as negative amounts, refunds as positive. Use this to see exactly what hit your card for a specific order, especially when an order has partial refunds or split shipment charges."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct TransactionsTool {
    /// Order ID, e.g. "111-9870271-4101823"
    order_id: String,
}

impl TransactionsTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let txns = client.transactions(&self.order_id).await.map_err(err)?;
        json_result(&txns)
    }
}

#[mcp_tool(
    name = "amazon_login",
    description = "Re-authenticate the Amazon session when other tools return an 'auth_expired' error. Opens the Amazon order-history page in the user's default browser, then polls Chrome's cookie store until a valid session appears (the user must finish signing in, including any 2FA). Returns status 'already_authenticated' (session was still valid), 'authenticated' (refreshed successfully), or 'timeout' (no valid session before the deadline -- call again after finishing sign-in). Reads cookies from the browser the user just logged into, so no manual cookie export is needed."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct LoginTool {
    /// Seconds to wait for the user to complete sign-in before giving up (default 120).
    #[serde(default = "default_login_timeout")]
    timeout_secs: u64,
}

fn default_login_timeout() -> u64 { 120 }

impl LoginTool {
    pub async fn run(&self, client: &AmazonClient) -> Result<CallToolResult, CallToolError> {
        let result = client.login(self.timeout_secs).await.map_err(err)?;
        json_result(&result)
    }
}

tool_box!(AmazonTools, [ListOrdersTool, ListDigitalOrdersTool, PrimePaymentsTool, SearchOrdersTool, ReconcileChargeTool, InvoiceTool, OrderDetailsTool, TrackPackageTool, DumpOrdersTool, ListReturnsTool, TransactionsTool, LoginTool]);

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{Context, Result};

    #[test]
    fn test_error_preserves_context() {
        let inner: Result<()> = Err(anyhow::anyhow!("connection refused"));
        let outer = inner.context("fetching page 2 (startIndex=10)");
        let tool_err = err(outer.unwrap_err());
        let msg = format!("{}", tool_err.0);
        assert!(msg.contains("connection refused"), "must contain root cause");
        assert!(msg.contains("page 2"), "must contain context");
    }

    #[test]
    fn test_auth_expired_maps_to_structured_payload() {
        // Even wrapped in context (as callers do), an AuthExpired root must produce
        // the actionable JSON payload rather than an opaque string.
        let e = anyhow::Error::new(AuthExpired).context("page 1 (startIndex=0)");
        let tool_err = err(e);
        let msg = format!("{}", tool_err.0);
        let parsed: serde_json::Value = serde_json::from_str(&msg)
            .expect("auth_expired errors must be valid JSON");
        assert_eq!(parsed["error"], "auth_expired");
        assert_eq!(parsed["signin_url"], ORDER_HISTORY_URL);
        assert!(parsed["action"].as_str().unwrap().contains("amazon_login"));
    }

    #[test]
    fn test_non_auth_error_stays_plain() {
        let tool_err = err(anyhow::anyhow!("HTTP 500 for /your-orders"));
        let msg = format!("{}", tool_err.0);
        assert!(msg.contains("HTTP 500"));
        assert!(!msg.contains("auth_expired"));
    }
}
