mod models;
mod client;
mod tools;
mod handler;

use std::sync::Arc;

use client::TargetClient;
use handler::TargetOrdersHandler;
use rust_mcp_sdk::schema::{
    Implementation, InitializeResult, LATEST_PROTOCOL_VERSION, ServerCapabilities,
    ServerCapabilitiesTools,
};
use rust_mcp_sdk::{
    McpServer,
    StdioTransport, TransportOptions,
    error::SdkResult,
    mcp_server::{McpServerOptions, ToMcpServerHandler, server_runtime},
};

#[tokio::main]
async fn main() -> SdkResult<()> {
    let server_details = InitializeResult {
        server_info: Implementation {
            name: "target-orders".into(),
            version: "0.1.0".to_string(),
            title: Some("Target Orders".into()),
            description: Some("Query Target purchase history (online and in-store)".into()),
            icons: vec![],
            website_url: None,
        },
        capabilities: ServerCapabilities {
            tools: Some(ServerCapabilitiesTools { list_changed: None }),
            ..Default::default()
        },
        meta: None,
        instructions: Some(
            "Target purchase history via their JSON API. Requires TARGET_COOKIES env var pointing to a cookies file, \
             or cookies at ~/.config/target-orders/cookies.txt. \
             Use target_list_orders with purchase_type STORE or ONLINE."
                .into(),
        ),
        protocol_version: LATEST_PROTOCOL_VERSION.to_string(),
    };

    let cookies_path = std::env::var("TARGET_COOKIES").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        format!("{}/.config/target-orders/cookies.txt", home)
    });
    let client = Arc::new(
        TargetClient::new(&cookies_path).expect("failed to load Target cookies")
    );

    let transport = StdioTransport::new(TransportOptions::default())?;
    let handler = TargetOrdersHandler { client };

    let server = server_runtime::create_server(McpServerOptions {
        server_details,
        transport,
        handler: handler.to_mcp_server_handler(),
        task_store: None,
        client_task_store: None,
    });

    server.start().await
}
