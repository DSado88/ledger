use rust_mcp_sdk::macros::{JsonSchema, mcp_tool};
use rust_mcp_sdk::schema::{CallToolResult, TextContent, schema_utils::CallToolError};
use rust_mcp_sdk::tool_box;

use crate::client::TargetClient;

#[derive(Debug)]
struct ToolErr(String);
impl std::fmt::Display for ToolErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ToolErr {}

fn err(e: anyhow::Error) -> CallToolError {
    CallToolError::new(ToolErr(format!("{:#}", e)))
}

fn json_result<T: serde::Serialize>(val: &T) -> Result<CallToolResult, CallToolError> {
    let json = serde_json::to_string_pretty(val)
        .map_err(|e| CallToolError::new(ToolErr(e.to_string())))?;
    Ok(CallToolResult::text_content(vec![TextContent::from(json)]))
}

#[mcp_tool(
    name = "target_list_orders",
    description = "List Target orders (online or in-store). Returns order summaries with dates, totals, items, store locations, and receipt IDs. Set purchase_type to ONLINE or STORE."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct ListOrdersTool {
    /// "ONLINE" or "STORE"
    #[serde(default = "default_purchase_type")]
    purchase_type: String,
    /// Page number (1-based)
    #[serde(default = "default_page")]
    page: u32,
    /// Results per page (1-50)
    #[serde(default = "default_page_size")]
    page_size: u32,
}

fn default_purchase_type() -> String { "STORE".into() }
fn default_page() -> u32 { 1 }
fn default_page_size() -> u32 { 10 }

impl ListOrdersTool {
    pub async fn run(&self, client: &TargetClient) -> Result<CallToolResult, CallToolError> {
        let resp = client.list_orders(&self.purchase_type, self.page, self.page_size)
            .await.map_err(err)?;
        json_result(&resp)
    }
}

#[mcp_tool(
    name = "target_list_all_orders",
    description = "List ALL Target orders across all pages for a purchase type. Returns every order. Can be slow for large histories."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct ListAllOrdersTool {
    /// "ONLINE" or "STORE"
    #[serde(default = "default_purchase_type_all")]
    purchase_type: String,
}

fn default_purchase_type_all() -> String { "STORE".into() }

impl ListAllOrdersTool {
    pub async fn run(&self, client: &TargetClient) -> Result<CallToolResult, CallToolError> {
        let orders = client.list_all_orders(&self.purchase_type, 20)
            .await.map_err(err)?;
        json_result(&orders)
    }
}

#[mcp_tool(
    name = "target_search_orders",
    description = "Search for active Target orders. Returns currently active/pending orders."
)]
#[derive(Debug, serde::Deserialize, serde::Serialize, JsonSchema)]
pub struct SearchOrdersTool {
    /// "ONLINE" or "STORE"
    #[serde(default = "default_purchase_type_search")]
    purchase_type: String,
    /// Only return active orders
    #[serde(default = "default_active")]
    active_only: bool,
}

fn default_purchase_type_search() -> String { "ONLINE".into() }
fn default_active() -> bool { true }

impl SearchOrdersTool {
    pub async fn run(&self, client: &TargetClient) -> Result<CallToolResult, CallToolError> {
        let resp = client.search_orders(&self.purchase_type, self.active_only)
            .await.map_err(err)?;
        json_result(&resp)
    }
}

tool_box!(TargetTools, [ListOrdersTool, ListAllOrdersTool, SearchOrdersTool]);
