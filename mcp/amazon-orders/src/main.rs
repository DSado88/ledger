mod models;
mod parse;
mod client;
mod browser;
mod tools;
mod handler;

use std::sync::Arc;

use client::AmazonClient;
use handler::AmazonOrdersHandler;
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
            name: "amazon-orders".into(),
            version: "0.1.0".to_string(),
            title: Some("Amazon Orders".into()),
            description: Some("Query Amazon order history, invoices, and tracking".into()),
            icons: vec![],
            website_url: None,
        },
        capabilities: ServerCapabilities {
            tools: Some(ServerCapabilitiesTools { list_changed: None }),
            ..Default::default()
        },
        meta: None,
        instructions: Some(
            "Amazon order history scraper. Requires AMAZON_COOKIES env var pointing to a cookies file, \
             or cookies at ~/.config/amazon-orders/cookies.txt. Falls back to Chrome's cookie store via Rookie.\n\n\
             WHICH TOOL TO USE:\n\
             - 'What is this charge?' → amazon_reconcile_charge (searches all 3 systems, pulls invoices, matches on actual card charge)\n\
             - 'What did I spend this month?' → amazon_list_orders + amazon_list_digital_orders + amazon_prime_payments (all 3 needed for complete picture)\n\
             - 'Show me order details' → amazon_invoice (financials) or amazon_order_details (shipping/items)\n\
             - 'Find orders around $X' → amazon_search_orders (quick) or amazon_reconcile_charge (thorough)\n\
             - 'Track my package' → amazon_track_package\n\
             - 'Dump everything' → amazon_dump_orders\n\
             - Session expired (tool returned {\"error\":\"auth_expired\"}) → amazon_login, then retry\n\n\
             AUTH: When any tool returns a structured error with \"error\":\"auth_expired\", the Amazon \
             session has expired. Call amazon_login (opens a browser, polls Chrome cookies until the user \
             signs in), then retry the original tool. Do NOT improvise a browser-automation flow.\n\n\
             CRITICAL: THINGS THAT WILL FOOL YOU\n\
             1. Order total ≠ card charge. Gift cards, rewards points, and S&S discounts reduce the charged amount. \
                The invoice Grand Total is what hit the card. The order list total is the sticker price. \
                A $356 order can produce an $84 charge if gift cards covered the rest.\n\
             2. Order date ≠ charge date. Subscribe & Save orders charge when the item SHIPS, not when ordered. \
                An April 19 order can produce a May 3 charge. Use 30-day lookback windows, not exact date matching.\n\
             3. Amazon has THREE separate billing systems: physical orders, digital orders (Music/Kindle/Audible), \
                and Prime membership. A charge could come from any of them. Check the merchant name to narrow scope.\n\
             4. Chase merchant names: 'AMZN MKTP US*' = physical, 'Amazon.com*' = physical shipment, \
                'Amazon Digit*' = digital, 'Amazon Prime' = membership. The *-suffix codes are NOT order IDs.\n\
             5. Multi-item orders can split into separate charges per shipment. Each charge includes its share of tax.\n\
             6. Do NOT do arithmetic on dollar strings yourself. Use amazon_reconcile_charge which parses amounts \
                and matches against invoice grand totals with proper tolerance.\n\
             7. When reconcile_charge returns no ExactGrandTotal match, try increasing tolerance or max_candidates \
                before concluding no match exists."
                .into(),
        ),
        protocol_version: LATEST_PROTOCOL_VERSION.to_string(),
    };

    let cookies_path = std::env::var("AMAZON_COOKIES").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        format!("{}/.config/amazon-orders/cookies.txt", home)
    });
    // Start even when cookies are missing/stale so amazon_login can recover the session.
    let client = Arc::new(AmazonClient::new(&cookies_path).unwrap_or_else(|e| {
        eprintln!("startup: no valid cookies ({}). Call amazon_login to authenticate.", e);
        AmazonClient::unauthenticated(&cookies_path).expect("building unauthenticated client")
    }));

    let transport = StdioTransport::new(TransportOptions::default())?;
    let handler = AmazonOrdersHandler { client };

    let server = server_runtime::create_server(McpServerOptions {
        server_details,
        transport,
        handler: handler.to_mcp_server_handler(),
        task_store: None,
        client_task_store: None,
    });

    server.start().await
}
