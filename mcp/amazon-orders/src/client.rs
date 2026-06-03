use anyhow::{Context, Result, bail};
use chrono::Datelike;
use regex::Regex;
use reqwest::header::{self, HeaderMap, HeaderValue};
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

use crate::models::*;
use crate::parse;

const BASE: &str = "https://www.amazon.com";
const MAX_PAGES: usize = 50;

/// Page to open for interactive login and to probe session validity. Redirects to
/// the sign-in flow when the session is dead, otherwise renders order history.
pub const ORDER_HISTORY_URL: &str = "https://www.amazon.com/gp/css/order-history";

/// Upper bound on the login poll so a caller can't pin a request open indefinitely.
const MAX_LOGIN_TIMEOUT_SECS: u64 = 600;

fn clamp_login_timeout(secs: u64) -> u64 {
    secs.clamp(1, MAX_LOGIN_TIMEOUT_SECS)
}

/// Typed error signalling the Amazon session is no longer valid (cookies expired).
/// Surfaced to callers as a structured `auth_expired` payload so an agent knows to
/// call `amazon_login` rather than guessing at a browser flow.
#[derive(Debug)]
pub struct AuthExpired;
impl std::fmt::Display for AuthExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("auth_expired")
    }
}
impl std::error::Error for AuthExpired {}

static RE_ORDER_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(D\d{2}|\d{3})-\d{7}-\d{7}$").unwrap());

pub(crate) fn validate_order_id(id: &str) -> Result<()> {
    if !RE_ORDER_ID.is_match(id) {
        bail!("invalid order ID format: {}", id);
    }
    Ok(())
}

pub(crate) fn validate_param(p: &str) -> Result<()> {
    if p.is_empty() || p.contains('&') || p.contains('=') || p.contains(' ') || p.contains('#') || p.contains('%') {
        bail!("invalid parameter: {}", p);
    }
    Ok(())
}

static RE_FILTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(last30|months-3|year-\d{4})$").unwrap());

pub(crate) fn validate_filter(f: &str) -> Result<()> {
    if !RE_FILTER.is_match(f) {
        bail!("invalid time filter: {}. Expected last30, months-3, or year-YYYY", f);
    }
    Ok(())
}

pub fn load_cookies_from_browser() -> Result<String> {
    let cookies = rookie::chrome(Some(vec!["amazon.com".to_string()]))
        .map_err(|e| anyhow::anyhow!("rookie: {}", e))?;

    let pairs: Vec<String> = cookies
        .into_iter()
        .filter(|c| {
            let d = c.domain.trim_start_matches('.');
            d == "amazon.com" || d.ends_with(".amazon.com")
        })
        .map(|c| format!("{}={}", c.name, c.value))
        .collect();

    if pairs.is_empty() {
        bail!("no Amazon cookies found in Chrome -- log into amazon.com first");
    }

    Ok(pairs.join("; "))
}

pub struct AmazonClient {
    /// Swappable so `amazon_login` can refresh cookies without restarting the server.
    http: RwLock<reqwest::Client>,
    cookies_path: String,
}

impl AmazonClient {
    pub fn new(cookies_path: &str) -> Result<Self> {
        let cookies_header = Self::resolve_cookies(cookies_path)?;
        let http = Self::build_http(&cookies_header)?;
        Ok(Self {
            http: RwLock::new(http),
            cookies_path: cookies_path.to_string(),
        })
    }

    /// Construct without valid cookies so the server still starts; the user can then
    /// recover via `amazon_login`. Requests will return `auth_expired` until then.
    pub fn unauthenticated(cookies_path: &str) -> Result<Self> {
        let http = Self::build_http("")?;
        Ok(Self {
            http: RwLock::new(http),
            cookies_path: cookies_path.to_string(),
        })
    }

    fn build_http(cookies_header: &str) -> Result<reqwest::Client> {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
            ),
        );
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
        );
        headers.insert(
            header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("en-US,en;q=0.9"),
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(cookies_header)?,
        );

        let http = reqwest::Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::limited(10))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(http)
    }

    /// Rebuild the underlying HTTP client with a fresh cookie header.
    fn set_cookies(&self, cookies_header: &str) -> Result<()> {
        let client = Self::build_http(cookies_header)?;
        // Recover from a poisoned lock rather than panicking the request: the guarded
        // reqwest::Client has no invariant a panicking thread could have corrupted.
        *self.http.write().unwrap_or_else(|e| e.into_inner()) = client;
        Ok(())
    }

    /// Clone the current HTTP client (cheap: reqwest::Client is Arc-backed) without
    /// holding the lock across an await point.
    fn http(&self) -> reqwest::Client {
        self.http.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn resolve_cookies(cookies_path: &str) -> Result<String> {
        // Try cookie file first (usually freshest -- updated via CDP or manual export)
        match load_cookies(cookies_path) {
            Ok(cookies) => {
                eprintln!("cookies: loaded from {}", cookies_path);
                return Ok(cookies);
            }
            Err(e) => {
                eprintln!("cookies: file failed ({}), trying Chrome via rookie", e);
            }
        }

        // Fall back to Rookie (reads Chrome's on-disk cookie store)
        match load_cookies_from_browser() {
            Ok(cookies) => {
                eprintln!("cookies: loaded from Chrome via rookie");
                return Ok(cookies);
            }
            Err(e) => {
                eprintln!("cookies: rookie failed ({})", e);
            }
        }

        bail!("no cookies available -- log into amazon.com in Chrome and export cookies, or ensure Chrome has a fresh Amazon session")
    }

    async fn get(&self, url: &str) -> Result<String> {
        eprintln!("  GET {}", url);
        let resp = self.http().get(url).send().await?;
        let status = resp.status();
        if !status.is_success() && !status.is_redirection() {
            bail!("HTTP {} for {}", status, url);
        }
        let body = resp.text().await?;
        if is_signin_page(&body) {
            return Err(AuthExpired.into());
        }
        Ok(body)
    }

    /// True when the current cookies yield an authenticated session.
    pub async fn check_session(&self) -> bool {
        let url = format!("{}/your-orders/orders?timeFilter=last30&startIndex=0", BASE);
        self.get(&url).await.is_ok()
    }

    /// Open the Amazon sign-in page in the user's browser and poll Chrome's cookie
    /// store until a valid session appears. Pulls cookies from the browser (Rookie)
    /// specifically -- the whole point is that the user just logged in there, so any
    /// stale cookie file should be ignored.
    pub async fn login(&self, timeout_secs: u64) -> Result<LoginResult> {
        let timeout_secs = clamp_login_timeout(timeout_secs);
        if self.check_session().await {
            return Ok(LoginResult {
                status: "already_authenticated".into(),
                message: "Existing Amazon session is still valid.".into(),
                signin_url: ORDER_HISTORY_URL.into(),
                elapsed_secs: 0,
            });
        }

        open_url(ORDER_HISTORY_URL).context("opening Amazon sign-in page")?;
        eprintln!("login: opened {} -- waiting for sign-in", ORDER_HISTORY_URL);

        let start = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

            // Chrome flushes cookies to disk lazily, so the fresh session may take a
            // few seconds to land. Each tick, try the browser store first (the user
            // just signed in there), then fall back to the cookie file (covers the
            // manual-export / CDP-refresh workflow). Re-probe after each swap.
            let sources = [
                load_cookies_from_browser(),
                load_cookies(&self.cookies_path),
            ];
            for header in sources.into_iter().flatten() {
                if self.set_cookies(&header).is_ok() && self.check_session().await {
                    return Ok(LoginResult {
                        status: "authenticated".into(),
                        message: "Amazon session refreshed.".into(),
                        signin_url: ORDER_HISTORY_URL.into(),
                        elapsed_secs: start.elapsed().as_secs(),
                    });
                }
            }

            if start.elapsed().as_secs() >= timeout_secs {
                return Ok(LoginResult {
                    status: "timeout".into(),
                    message: format!(
                        "No valid session after {}s. Finish signing in to amazon.com in the \
                         opened browser, then call amazon_login again.",
                        timeout_secs
                    ),
                    signin_url: ORDER_HISTORY_URL.into(),
                    elapsed_secs: start.elapsed().as_secs(),
                });
            }
        }
    }

    pub async fn list_orders(&self, filter: &str, max_pages: usize) -> Result<Vec<OrderSummary>> {
        validate_filter(filter)?;
        let max_pages = max_pages.min(MAX_PAGES);
        let mut all_orders = Vec::new();
        let mut start_index = 0;

        for page in 0..max_pages {
            let url = format!(
                "{}/your-orders/orders?timeFilter={}&startIndex={}",
                BASE, filter, start_index
            );
            let html = self.get(&url).await
                .with_context(|| format!("page {} (startIndex={})", page + 1, start_index))?;

            let mut orders = parse::parse_order_list(&html)?;
            if orders.is_empty() {
                break;
            }

            all_orders.append(&mut orders);

            if !parse::has_next_page(&html) {
                break;
            }

            start_index += 10;
            tokio::time::sleep(Duration::from_millis(800)).await;
        }

        Ok(all_orders)
    }

    pub async fn list_digital_orders(&self, filter: &str, max_pages: usize) -> Result<Vec<OrderSummary>> {
        validate_filter(filter)?;
        let max_pages = max_pages.min(MAX_PAGES);
        let mut all_orders = Vec::new();
        let mut start_index = 0;

        for page in 0..max_pages {
            let url = format!(
                "{}/your-orders/orders?orderFilter=digital&timeFilter={}&startIndex={}",
                BASE, filter, start_index
            );
            let html = self.get(&url).await
                .with_context(|| format!("digital page {} (startIndex={})", page + 1, start_index))?;

            let mut orders = parse::parse_order_list(&html)?;
            if orders.is_empty() {
                break;
            }

            all_orders.append(&mut orders);

            if !parse::has_next_page(&html) {
                break;
            }

            start_index += 10;
            tokio::time::sleep(Duration::from_millis(800)).await;
        }

        Ok(all_orders)
    }

    pub async fn prime_payments(&self) -> Result<Vec<PrimePayment>> {
        let url = format!("{}/mc/payments", BASE);
        let html = self.get(&url).await?;
        parse::parse_prime_payments(&html)
    }

    pub async fn order_details(&self, order_id: &str) -> Result<OrderDetail> {
        validate_order_id(order_id)?;
        let url = format!("{}/your-orders/order-details?orderID={}", BASE, order_id);
        let html = self.get(&url).await?;
        parse::parse_order_details(&html, order_id)
    }

    pub async fn invoice(&self, order_id: &str) -> Result<Invoice> {
        validate_order_id(order_id)?;
        let url = format!("{}/gp/css/summary/print.html?orderID={}", BASE, order_id);
        let html = self.get(&url).await?;
        parse::parse_invoice(&html, order_id)
    }

    pub async fn tracking(
        &self,
        order_id: &str,
        item_id: &str,
        shipment_id: &str,
    ) -> Result<TrackingInfo> {
        validate_order_id(order_id)?;
        validate_param(item_id)?;
        validate_param(shipment_id)?;
        let url = format!(
            "{}/gp/your-account/ship-track?itemId={}&orderId={}&shipmentId={}&packageIndex=0",
            BASE, item_id, order_id, shipment_id
        );
        let html = self.get(&url).await?;
        parse::parse_tracking(&html, order_id)
    }

    pub async fn full_dump(&self, filter: &str) -> Result<FullDump> {
        eprintln!("fetching order list for filter={}", filter);
        let summaries = self.list_orders(filter, MAX_PAGES).await?;
        eprintln!("found {} orders", summaries.len());

        let total = summaries.len();
        let mut orders = Vec::new();
        for (i, summary) in summaries.into_iter().enumerate() {
            eprintln!("[{}/{}] invoice for {}", i + 1, total, summary.order_id);
            let invoice = match self.invoice(&summary.order_id).await {
                Ok(inv) => Some(inv),
                Err(e) => {
                    eprintln!("  warning: invoice failed: {}", e);
                    None
                }
            };

            orders.push(DumpOrder { summary, invoice });
            tokio::time::sleep(Duration::from_millis(600)).await;
        }

        Ok(FullDump {
            scraped_at: chrono::Utc::now().to_rfc3339(),
            filter: filter.to_string(),
            orders,
        })
    }

    pub async fn list_returns(&self) -> Result<Vec<ReturnSummary>> {
        let url = format!("{}/your-returns", BASE);
        let html = self.get(&url).await?;
        parse::parse_returns(&html)
    }

    pub async fn transactions(&self, order_id: &str) -> Result<TransactionList> {
        validate_order_id(order_id)?;
        let url = format!(
            "{}/cpe/yourpayments/transactions?transactionTag={}",
            BASE, order_id
        );
        let html = self.get(&url).await?;
        parse::parse_transactions(&html, order_id)
    }

    pub async fn reconcile_charge(
        &self,
        amount: f64,
        charge_date: &str,
        merchant_name: Option<&str>,
        tolerance: f64,
        max_candidates: usize,
    ) -> Result<ReconcileResult> {
        let parsed_date = parse::parse_date_to_ymd(charge_date)
            .ok_or_else(|| anyhow::anyhow!("cannot parse charge date: {}", charge_date))?;

        let scope = merchant_name
            .map(parse::classify_merchant)
            .unwrap_or(ChargeSource::Unknown);

        let filter = lookback_filter(&parsed_date);

        let (search_physical, search_digital, search_prime) = match &scope {
            ChargeSource::Physical => (true, false, false),
            ChargeSource::Digital => (false, true, false),
            ChargeSource::Prime => (false, false, true),
            ChargeSource::Unknown => (true, true, true),
        };

        let (physical, digital, prime) = tokio::join!(
            async {
                if search_physical { self.list_orders(&filter, MAX_PAGES).await.unwrap_or_default() }
                else { Vec::new() }
            },
            async {
                if search_digital { self.list_digital_orders(&filter, MAX_PAGES).await.unwrap_or_default() }
                else { Vec::new() }
            },
            async {
                if search_prime { self.prime_payments().await.unwrap_or_default() }
                else { Vec::new() }
            },
        );

        let window_start = parsed_date - chrono::Duration::days(30);

        let mut pre_candidates: Vec<(f64, OrderSummary, ChargeSource)> = Vec::new();
        let mut offset_candidates: Vec<(f64, OrderSummary, ChargeSource)> = Vec::new();

        for order in physical {
            if !in_date_window(&order.date, &window_start, &parsed_date) {
                continue;
            }
            if let Some(diff) = amount_diff(&order.total, amount, tolerance) {
                pre_candidates.push((diff, order, ChargeSource::Physical));
            } else if let Some(order_total) = order.total.as_deref().and_then(parse::parse_dollar) {
                if order_total > amount + tolerance {
                    offset_candidates.push((order_total - amount, order, ChargeSource::Physical));
                }
            }
        }

        for order in digital {
            if !in_date_window(&order.date, &window_start, &parsed_date) {
                continue;
            }
            if let Some(diff) = amount_diff(&order.total, amount, tolerance) {
                pre_candidates.push((diff, order, ChargeSource::Digital));
            } else if let Some(order_total) = order.total.as_deref().and_then(parse::parse_dollar) {
                if order_total > amount + tolerance {
                    offset_candidates.push((order_total - amount, order, ChargeSource::Digital));
                }
            }
        }

        for payment in prime {
            if let Some(diff) = amount_diff(&payment.total, amount, tolerance) {
                if in_date_window(&Some(payment.date.clone()), &window_start, &parsed_date) {
                    let summary = OrderSummary {
                        order_id: payment.order_id.unwrap_or_else(|| "prime-payment".into()),
                        date: Some(payment.date),
                        total: payment.total,
                        ship_to: None,
                        status: Some("Prime Payment".into()),
                        status_detail: None,
                        subscribe_and_save: false,
                        products: vec![ProductSummary {
                            title: Some("Amazon Prime Membership".into()),
                            asin: None,
                            image_url: None,
                            image_hires_url: None,
                            return_eligibility: None,
                        }],
                        detail_url: String::new(),
                        invoice_url: payment.receipt_url.unwrap_or_default(),
                    };
                    pre_candidates.push((diff, summary, ChargeSource::Prime));
                }
            }
        }

        pre_candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        // Fill remaining slots with offset candidates (orders where total > charge, likely gift card/rewards)
        let remaining = max_candidates.saturating_sub(pre_candidates.len());
        if remaining > 0 {
            offset_candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            offset_candidates.truncate(remaining);
            pre_candidates.extend(offset_candidates);
        }
        pre_candidates.truncate(max_candidates);

        let mut candidates = Vec::new();
        for (order_total_diff, summary, source) in pre_candidates {
            let (breakdown, payment_methods) = if source != ChargeSource::Prime
                && validate_order_id(&summary.order_id).is_ok()
            {
                match self.invoice(&summary.order_id).await {
                    Ok(inv) => {
                        let bd = parse::extract_breakdown(&inv.financials);
                        (Some(bd), inv.payment_methods)
                    }
                    Err(e) => {
                        eprintln!("  warning: invoice for {} failed: {}", summary.order_id, e);
                        (None, Vec::new())
                    }
                }
            } else {
                (None, Vec::new())
            };

            let (match_quality, amount_diff_val) = match &breakdown {
                Some(bd) => match bd.grand_total {
                    Some(gt) => {
                        let diff = (gt - amount).abs();
                        if diff < 0.005 {
                            (MatchQuality::ExactGrandTotal, diff)
                        } else if diff <= tolerance {
                            (MatchQuality::FuzzyGrandTotal, diff)
                        } else if order_total_diff < 0.005 {
                            (MatchQuality::ExactOrderTotal, order_total_diff)
                        } else {
                            (MatchQuality::FuzzyOrderTotal, order_total_diff)
                        }
                    }
                    None => {
                        if order_total_diff < 0.005 {
                            (MatchQuality::ExactOrderTotal, order_total_diff)
                        } else {
                            (MatchQuality::FuzzyOrderTotal, order_total_diff)
                        }
                    }
                },
                None => (MatchQuality::NoInvoice, order_total_diff),
            };

            candidates.push(ReconcileCandidate {
                match_quality,
                amount_diff: amount_diff_val,
                source: source.clone(),
                order_id: summary.order_id,
                order_date: summary.date,
                order_total: summary.total,
                subscribe_and_save: summary.subscribe_and_save,
                products: summary.products,
                breakdown,
                payment_methods,
            });

            if candidates.len() < max_candidates {
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        }

        candidates.sort_by(|a, b| {
            fn rank(q: &MatchQuality) -> u8 {
                match q {
                    MatchQuality::ExactGrandTotal => 0,
                    MatchQuality::ExactOrderTotal => 1,
                    MatchQuality::FuzzyGrandTotal => 2,
                    MatchQuality::FuzzyOrderTotal => 3,
                    MatchQuality::NoInvoice => 4,
                }
            }
            rank(&a.match_quality)
                .cmp(&rank(&b.match_quality))
                .then(a.amount_diff.partial_cmp(&b.amount_diff).unwrap_or(std::cmp::Ordering::Equal))
        });

        Ok(ReconcileResult {
            charge_amount: amount,
            charge_date: charge_date.to_string(),
            merchant_name: merchant_name.map(String::from),
            search_scope: scope,
            candidates,
        })
    }
}

/// Heuristic: Amazon serves the sign-in form (not order content) when the session is dead.
fn is_signin_page(body: &str) -> bool {
    body.contains("Sign in") && body.contains("ap_email") && !body.contains("order-header")
}

/// The OS command that opens a URL in the user's default browser.
fn opener_command(url: &str) -> (&'static str, Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        ("open", vec![url.to_string()])
    }
    #[cfg(target_os = "windows")]
    {
        // empty title arg so a quoted URL isn't mistaken for the window title
        ("cmd", vec!["/C".into(), "start".into(), String::new(), url.to_string()])
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        ("xdg-open", vec![url.to_string()])
    }
}

fn open_url(url: &str) -> Result<()> {
    let (program, args) = opener_command(url);
    std::process::Command::new(program)
        .args(&args)
        .spawn()
        .with_context(|| format!("launching browser via {}", program))?;
    Ok(())
}

fn amount_diff(total: &Option<String>, target: f64, tolerance: f64) -> Option<f64> {
    let parsed = parse::parse_dollar(total.as_deref()?)?;
    let diff = (parsed - target).abs();
    if diff <= tolerance { Some(diff) } else { None }
}

fn in_date_window(
    order_date: &Option<String>,
    window_start: &chrono::NaiveDate,
    charge_date: &chrono::NaiveDate,
) -> bool {
    match order_date.as_deref().and_then(parse::parse_date_to_ymd) {
        Some(d) => d >= *window_start && d <= *charge_date,
        None => true,
    }
}

fn lookback_filter(charge_date: &chrono::NaiveDate) -> String {
    let earliest_order = *charge_date - chrono::Duration::days(30);
    let today = chrono::Utc::now().date_naive();
    let days_to_earliest = (today - earliest_order).num_days();
    if days_to_earliest <= 30 {
        "last30".to_string()
    } else if days_to_earliest <= 90 {
        "months-3".to_string()
    } else {
        format!("year-{}", earliest_order.year())
    }
}

/// Load cookies from a file. Supports:
/// 1. Netscape/curl cookie format (tab-separated)
/// 2. Raw Cookie header value (single line starting with session-id=)
/// 3. JSON array of {name, value} objects (browser export extensions)
fn is_amazon_domain(domain: &str) -> bool {
    let d = domain.trim_start_matches('.');
    d == "amazon.com" || d.ends_with(".amazon.com")
}

pub(crate) fn load_cookies(path: &str) -> Result<String> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("reading cookies from {}", path))?;
    let content = content.trim();

    // Raw cookie header
    if content.starts_with("session-id=") || content.starts_with("ubid-main=") {
        return Ok(content.to_string());
    }

    // JSON array format (e.g. EditThisCookie export)
    if content.starts_with('[') {
        let cookies: Vec<serde_json::Value> = serde_json::from_str(content)
            .context("parsing JSON cookies")?;
        let pairs: Vec<String> = cookies
            .iter()
            .filter_map(|c| {
                let domain = c.get("domain").and_then(|d| d.as_str()).unwrap_or("");
                if !is_amazon_domain(domain) {
                    return None;
                }
                let name = c.get("name")?.as_str()?;
                let value = c.get("value")?.as_str()?;
                Some(format!("{}={}", name, value))
            })
            .collect();
        if pairs.is_empty() {
            bail!("JSON cookies file had no Amazon name/value pairs");
        }
        return Ok(pairs.join("; "));
    }

    // Netscape/curl format
    let mut pairs = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 7 {
            if !is_amazon_domain(parts[0]) {
                continue;
            }
            let name = parts[5];
            let value = parts[6];
            pairs.push(format!("{}={}", name, value));
        }
    }

    if pairs.is_empty() {
        bail!(
            "no cookies found in {}. Export cookies from your browser using:\n\
             - EditThisCookie extension (JSON export)\n\
             - curl cookie file (Netscape format)\n\
             - Or paste raw Cookie header into a text file",
            path
        );
    }

    Ok(pairs.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_cookies_json_filters_by_domain() {
        let dir = std::env::temp_dir().join("amazon_orders_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cookies_domain_test.json");
        std::fs::write(&path, r#"[
            {"name":"session-id","value":"abc","domain":".amazon.com"},
            {"name":"bank_session","value":"secret","domain":".chase.com"},
            {"name":"ubid-main","value":"def","domain":"www.amazon.com"}
        ]"#).unwrap();
        let result = load_cookies(path.to_str().unwrap()).unwrap();
        assert!(result.contains("session-id=abc"));
        assert!(result.contains("ubid-main=def"));
        assert!(!result.contains("bank_session"), "non-Amazon cookies must be filtered out");
        assert!(!result.contains("secret"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_cookies_netscape_filters_by_domain() {
        let dir = std::env::temp_dir().join("amazon_orders_test2");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cookies_netscape_test.txt");
        std::fs::write(&path, ".amazon.com\tTRUE\t/\tTRUE\t0\tsession-id\tabc123\n\
                                .chase.com\tTRUE\t/\tTRUE\t0\tbank_token\tsecretval\n\
                                www.amazon.com\tTRUE\t/\tTRUE\t0\tubid-main\tdef456\n").unwrap();
        let result = load_cookies(path.to_str().unwrap()).unwrap();
        assert!(result.contains("session-id=abc123"));
        assert!(result.contains("ubid-main=def456"));
        assert!(!result.contains("bank_token"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_rookie_cookie_format() {
        match load_cookies_from_browser() {
            Ok(header) => {
                assert!(header.contains('='), "cookie header must contain key=value pairs");
                assert!(!header.contains('\n'), "cookie header must be a single line");
                let known = ["session-id", "ubid-main", "at-main", "session-token"];
                let has_known = known.iter().any(|k| header.contains(k));
                assert!(has_known, "must contain at least one known Amazon cookie");
            }
            Err(_) => {}
        }
    }

    #[test]
    fn test_validate_order_id() {
        assert!(validate_order_id("111-9870271-4101823").is_ok());
        assert!(validate_order_id("113-3171086-1951457").is_ok());
        assert!(validate_order_id("D01-6065648-9206659").is_ok(), "digital order IDs must be accepted");
        assert!(validate_order_id("D01-3205040-1302627").is_ok(), "digital order IDs must be accepted");
        assert!(validate_order_id("111-123&injected=true").is_err());
        assert!(validate_order_id("'; DROP TABLE orders; --").is_err());
        assert!(validate_order_id("").is_err());
        assert!(validate_order_id("X99-1234567-1234567").is_err(), "only D-prefix digital IDs allowed");
    }

    #[test]
    fn test_validate_param() {
        assert!(validate_param("jmjgmvjmpnkooup").is_ok());
        assert!(validate_param("PxHRLFBz8").is_ok());
        assert!(validate_param("foo&bar=baz").is_err());
        assert!(validate_param("foo bar").is_err());
        assert!(validate_param("foo%26bar").is_err(), "percent-encoded & must be rejected");
        assert!(validate_param("foo%3Dbar").is_err(), "percent-encoded = must be rejected");
    }

    #[test]
    fn test_validate_filter() {
        assert!(validate_filter("last30").is_ok());
        assert!(validate_filter("months-3").is_ok());
        assert!(validate_filter("year-2026").is_ok());
        assert!(validate_filter("year-2013").is_ok());
        assert!(validate_filter("months-3&extra=inject").is_err());
        assert!(validate_filter("foo bar").is_err());
        assert!(validate_filter("").is_err());
    }

    #[test]
    fn test_amount_diff() {
        assert!(amount_diff(&Some("$42.74".into()), 42.74, 1.0).unwrap() < 0.005);
        assert!(amount_diff(&Some("$43.19".into()), 42.74, 1.0).is_some());
        assert!(amount_diff(&Some("$100.00".into()), 42.74, 1.0).is_none());
        assert!(amount_diff(&None, 42.74, 1.0).is_none());
    }

    #[test]
    fn test_in_date_window() {
        let charge = chrono::NaiveDate::from_ymd_opt(2026, 5, 20).unwrap();
        let start = charge - chrono::Duration::days(30);
        assert!(in_date_window(&Some("May 15, 2026".into()), &start, &charge));
        assert!(in_date_window(&Some("May 20, 2026".into()), &start, &charge));
        assert!(!in_date_window(&Some("March 20, 2026".into()), &start, &charge));
        assert!(!in_date_window(&Some("May 25, 2026".into()), &start, &charge));
        assert!(in_date_window(&None, &start, &charge));
    }

    #[test]
    fn test_is_signin_page() {
        let signin = r#"<form><input name="ap_email"><button>Sign in</button></form>"#;
        assert!(is_signin_page(signin), "sign-in form must be detected");
        let orders = r#"<div class="order-header">Sign in to your account settings</div>"#;
        assert!(!is_signin_page(orders), "real order pages must not trip detection");
        assert!(!is_signin_page("<html>nothing here</html>"));
    }

    #[test]
    fn test_opener_command() {
        let (program, args) = opener_command("https://www.amazon.com/gp/css/order-history");
        assert!(args.iter().any(|a| a.contains("amazon.com")), "url must be passed");
        #[cfg(target_os = "macos")]
        assert_eq!(program, "open");
        #[cfg(target_os = "windows")]
        assert_eq!(program, "cmd");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(program, "xdg-open");
    }

    #[test]
    fn test_clamp_login_timeout() {
        assert_eq!(clamp_login_timeout(120), 120, "in-range value passes through");
        assert_eq!(clamp_login_timeout(0), 1, "zero would never poll; floored to 1");
        assert_eq!(clamp_login_timeout(u64::MAX), MAX_LOGIN_TIMEOUT_SECS, "unbounded poll capped");
    }

    #[test]
    fn test_build_http_accepts_empty_and_real_cookies() {
        assert!(AmazonClient::build_http("").is_ok(), "empty cookies (unauthenticated) must build");
        assert!(AmazonClient::build_http("session-id=abc; ubid-main=def").is_ok());
    }

    #[test]
    fn test_set_cookies_swaps_client() {
        let client = AmazonClient::unauthenticated("/tmp/does-not-exist.txt").unwrap();
        assert!(client.set_cookies("session-id=fresh").is_ok());
    }

    #[test]
    fn test_lookback_filter() {
        // Charge today: earliest order = 30 days ago, which is within last30 from today
        let today = chrono::Utc::now().date_naive();
        assert_eq!(lookback_filter(&today), "last30");
        // Charge 40 days ago: earliest = 70 days ago, needs months-3
        let forty_ago = today - chrono::Duration::days(40);
        assert_eq!(lookback_filter(&forty_ago), "months-3");
        // Old charge: needs year filter
        let old = chrono::NaiveDate::from_ymd_opt(2024, 3, 15).unwrap();
        assert_eq!(lookback_filter(&old), "year-2024");
    }
}
