use anyhow::{Context, Result, bail};
use reqwest::header::{self, HeaderMap, HeaderValue};
use std::time::Duration;

use crate::models::*;

const API_BASE: &str = "https://api.target.com";
const API_KEY: &str = "ff457966e64d5e877fdbad070f276d18ecec4a01";
const MAX_PAGES: u32 = 20;

pub struct TargetClient {
    http: reqwest::Client,
}

impl TargetClient {
    pub fn new(cookies_path: &str) -> Result<Self> {
        let cookies = std::fs::read_to_string(cookies_path)
            .with_context(|| format!("reading cookies from {}", cookies_path))?;
        let cookies = cookies.trim().to_string();

        let mut headers = HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
            ),
        );
        headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("https://www.target.com/orders"),
        );
        headers.insert(header::COOKIE, HeaderValue::from_str(&cookies)?);
        headers.insert("x-api-key", HeaderValue::from_static(API_KEY));

        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(30))
            .build()?;

        Ok(Self { http })
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T> {
        eprintln!("  GET {}", url);
        let resp = self.http.get(url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            bail!("HTTP {} for {}: {}", status, url, &body[..body.len().min(200)]);
        }
        let body = resp.json::<T>().await
            .with_context(|| format!("parsing JSON from {}", url))?;
        Ok(body)
    }

    pub async fn list_orders(
        &self,
        purchase_type: &str,
        page: u32,
        page_size: u32,
    ) -> Result<OrderHistoryResponse> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 50);
        validate_purchase_type(purchase_type)?;

        let url = format!(
            "{}/guest_order_aggregations/v1/order_history\
             ?page_number={}&page_size={}&order_purchase_type={}\
             &pending_order=true&shipt_status=true",
            API_BASE, page, page_size, purchase_type
        );
        self.get_json(&url).await
    }

    pub async fn list_all_orders(
        &self,
        purchase_type: &str,
        max_pages: u32,
    ) -> Result<Vec<Order>> {
        let max_pages = max_pages.min(MAX_PAGES);
        let mut all_orders = Vec::new();

        for page in 1..=max_pages {
            let resp = self.list_orders(purchase_type, page, 10).await
                .with_context(|| format!("page {}", page))?;

            if resp.orders.is_empty() {
                break;
            }

            let at_last_page = resp.total_pages.map_or(false, |tp| page >= tp);
            all_orders.extend(resp.orders);

            if at_last_page {
                break;
            }

            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        Ok(all_orders)
    }

    pub async fn search_orders(
        &self,
        purchase_type: &str,
        active_only: bool,
    ) -> Result<OrderHistoryResponse> {
        validate_purchase_type(purchase_type)?;

        let url = format!(
            "{}/guest_order_aggregations/v1/orders/search\
             ?page_number=1&page_size=10&active_order={}&order_purchase_type={}",
            API_BASE, active_only, purchase_type
        );
        self.get_json(&url).await
    }
}

fn validate_purchase_type(t: &str) -> Result<()> {
    match t {
        "ONLINE" | "STORE" => Ok(()),
        _ => bail!("invalid purchase type: {}. Expected ONLINE or STORE", t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_purchase_type() {
        assert!(validate_purchase_type("ONLINE").is_ok());
        assert!(validate_purchase_type("STORE").is_ok());
        assert!(validate_purchase_type("ONLINE&extra=inject").is_err());
        assert!(validate_purchase_type("").is_err());
    }

    #[test]
    fn test_deserialize_missing_orders_field() {
        let json = r#"{"metadata":{"total_time":5}}"#;
        let resp: crate::models::OrderHistoryResponse = serde_json::from_str(json).unwrap();
        assert!(resp.orders.is_empty(), "missing orders field should default to empty vec");
    }

    #[test]
    fn test_deserialize_null_total_pages() {
        let json = r#"{"orders":[{"placed_date":"2025-01-01","order_lines":[]}],"total_pages":null}"#;
        let resp: crate::models::OrderHistoryResponse = serde_json::from_str(json).unwrap();
        assert!(resp.total_pages.is_none());
    }
}
