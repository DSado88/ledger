use crate::client::TargetClient;
use crate::tools::TargetTools;
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

pub struct TargetOrdersHandler {
    pub client: Arc<TargetClient>,
}

#[async_trait]
impl ServerHandler for TargetOrdersHandler {
    async fn handle_list_tools_request(
        &self,
        _params: Option<PaginatedRequestParams>,
        _runtime: Arc<dyn McpServer>,
    ) -> Result<ListToolsResult, RpcError> {
        Ok(ListToolsResult {
            meta: None,
            next_cursor: None,
            tools: TargetTools::tools(),
        })
    }

    async fn handle_call_tool_request(
        &self,
        params: CallToolRequestParams,
        _runtime: Arc<dyn McpServer>,
    ) -> Result<CallToolResult, CallToolError> {
        let tool: TargetTools = TargetTools::try_from(params).map_err(CallToolError::new)?;

        match tool {
            TargetTools::ListOrdersTool(t) => t.run(&self.client).await,
            TargetTools::ListAllOrdersTool(t) => t.run(&self.client).await,
            TargetTools::SearchOrdersTool(t) => t.run(&self.client).await,
        }
    }
}
