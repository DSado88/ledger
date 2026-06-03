use crate::client::AmazonClient;
use crate::tools::AmazonTools;
use async_trait::async_trait;
use rust_mcp_sdk::{
    McpServer,
    mcp_server::ServerHandler,
    schema::{
        CallToolRequestParams, CallToolResult, ListToolsResult, PaginatedRequestParams, RpcError,
        schema_utils::CallToolError,
    },
};
use std::sync::Arc;

pub struct AmazonOrdersHandler {
    pub client: Arc<AmazonClient>,
}

#[async_trait]
impl ServerHandler for AmazonOrdersHandler {
    async fn handle_list_tools_request(
        &self,
        _params: Option<PaginatedRequestParams>,
        _runtime: Arc<dyn McpServer>,
    ) -> Result<ListToolsResult, RpcError> {
        Ok(ListToolsResult {
            meta: None,
            next_cursor: None,
            tools: AmazonTools::tools(),
        })
    }

    async fn handle_call_tool_request(
        &self,
        params: CallToolRequestParams,
        _runtime: Arc<dyn McpServer>,
    ) -> Result<CallToolResult, CallToolError> {
        let tool: AmazonTools = AmazonTools::try_from(params).map_err(CallToolError::new)?;

        match tool {
            AmazonTools::ListOrdersTool(t) => t.run(&self.client).await,
            AmazonTools::ListDigitalOrdersTool(t) => t.run(&self.client).await,
            AmazonTools::PrimePaymentsTool(t) => t.run(&self.client).await,
            AmazonTools::SearchOrdersTool(t) => t.run(&self.client).await,
            AmazonTools::ReconcileChargeTool(t) => t.run(&self.client).await,
            AmazonTools::InvoiceTool(t) => t.run(&self.client).await,
            AmazonTools::OrderDetailsTool(t) => t.run(&self.client).await,
            AmazonTools::TrackPackageTool(t) => t.run(&self.client).await,
            AmazonTools::DumpOrdersTool(t) => t.run(&self.client).await,
            AmazonTools::ListReturnsTool(t) => t.run(&self.client).await,
            AmazonTools::TransactionsTool(t) => t.run(&self.client).await,
            AmazonTools::LoginTool(t) => t.run(&self.client).await,
        }
    }
}
