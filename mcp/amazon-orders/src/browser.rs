//! Hydrated page fetching via headless Chrome.
//!
//! As of June 2026, Amazon's order-list pages (orders, digital orders, payments,
//! returns, transactions) no longer contain order data in the served HTML. The
//! data arrives as encrypted payloads ("Siege" CSD) decrypted client-side by
//! WASM, keyed by the `csd-key` cookie. Plain HTTP + scraper sees only order IDs
//! in `data-csa-c-slot-id` attributes — nothing parseable.
//!
//! The hydrated DOM, however, renders the *old* markup (`.a-box-group`,
//! `orderID=` links, `.yohtmlc-product-title`), so the existing parsers work
//! unchanged when fed browser-rendered HTML. This module loads a page in
//! headless Chrome with the session cookies injected, waits for hydration, and
//! returns `document.documentElement.outerHTML`.
//!
//! Detail pages (order-details, invoice print, ship-track) are NOT encrypted
//! and stay on plain HTTP — faster and no Chrome dependency.

use anyhow::{Context, Result};
use headless_chrome::protocol::cdp::Network::CookieParam;
use headless_chrome::{Browser, LaunchOptions};
use std::sync::Mutex;
use std::time::Duration;

/// How long to wait for the Siege WASM decrypt + render before giving up and
/// returning whatever is in the DOM (a page with zero orders never shows the
/// marker, so a timeout is not an error).
const HYDRATION_TIMEOUT: Duration = Duration::from_secs(15);

/// Keep the browser alive between calls (multi-page listings, reconcile fanout)
/// but let it exit when idle so we don't hold a Chrome process forever.
const IDLE_BROWSER_TIMEOUT: Duration = Duration::from_secs(120);

pub struct HydratedFetcher {
    browser: Mutex<Option<Browser>>,
}

impl HydratedFetcher {
    pub fn new() -> Self {
        Self { browser: Mutex::new(None) }
    }

    /// Fetch `url` with the given Cookie header, wait for `wait_css` to appear
    /// (hydration marker), and return the hydrated document HTML.
    ///
    /// Blocking — call via `tokio::task::spawn_blocking`.
    pub fn fetch(&self, url: &str, cookies_header: &str, wait_css: &str) -> Result<String> {
        // One retry with a fresh browser: the idle timeout may have reaped the
        // previous process between calls, which surfaces as a transport error.
        match self.fetch_once(url, cookies_header, wait_css) {
            Ok(html) => Ok(html),
            Err(first_err) => {
                *self.browser.lock().unwrap_or_else(|e| e.into_inner()) = None;
                self.fetch_once(url, cookies_header, wait_css)
                    .with_context(|| format!("retry after browser error: {first_err}"))
            }
        }
    }

    fn fetch_once(&self, url: &str, cookies_header: &str, wait_css: &str) -> Result<String> {
        let browser = self.ensure_browser()?;

        let tab = browser.new_tab().context("opening browser tab")?;
        // Scope guard: close the tab even on early return so a long session
        // doesn't accumulate tabs in the shared browser process.
        let result = (|| {
            // Match the UA to the real Chrome binary, minus the "Headless" marker
            // Amazon could key on.
            let product = browser
                .get_version()
                .map(|v| v.product)
                .unwrap_or_else(|_| "Chrome/149.0.0.0".to_string());
            let chrome_ver = product.split('/').nth(1).unwrap_or("149.0.0.0");
            let ua = format!(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/{chrome_ver} Safari/537.36"
            );
            tab.set_user_agent(&ua, Some("en-US,en;q=0.9"), Some("macOS"))?;

            tab.set_cookies(cookie_params(cookies_header))
                .context("injecting session cookies")?;

            tab.navigate_to(url)?;
            tab.wait_until_navigated()?;

            if tab.get_url().contains("/ap/signin") {
                return Err(crate::client::AuthExpired.into());
            }

            // Wait for the hydration marker. Timing out is fine: an account with
            // zero orders in the window never renders the marker.
            let _ = tab.wait_for_element_with_custom_timeout(wait_css, HYDRATION_TIMEOUT);

            let html = tab.get_content().context("reading hydrated DOM")?;
            if crate::client::is_signin_page(&html) {
                return Err(crate::client::AuthExpired.into());
            }
            Ok(html)
        })();

        let _ = tab.close(true);
        result
    }

    fn ensure_browser(&self) -> Result<Browser> {
        let mut guard = self.browser.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(b) = guard.as_ref() {
            // A dead process fails fast here; caller's retry path replaces it.
            if b.get_version().is_ok() {
                return Ok(b.clone());
            }
            *guard = None;
        }

        let options = LaunchOptions::default_builder()
            .headless(true)
            .idle_browser_timeout(IDLE_BROWSER_TIMEOUT)
            .window_size(Some((1280, 1100)))
            .args(vec![std::ffi::OsStr::new("--disable-blink-features=AutomationControlled")])
            .build()
            .map_err(|e| anyhow::anyhow!("building Chrome launch options: {e}"))?;

        let browser = Browser::new(options).context(
            "launching headless Chrome (is Google Chrome installed?) — needed because \
             Amazon now encrypts order-list pages and they only render in a browser",
        )?;
        *guard = Some(browser.clone());
        Ok(browser)
    }
}

/// Split a raw `Cookie:` header into CDP cookie params scoped to .amazon.com.
fn cookie_params(header: &str) -> Vec<CookieParam> {
    header
        .split(';')
        .filter_map(|pair| {
            let pair = pair.trim();
            let (name, value) = pair.split_once('=')?;
            if name.is_empty() {
                return None;
            }
            Some(CookieParam {
                name: name.trim().to_string(),
                value: value.to_string(),
                url: None,
                domain: Some(".amazon.com".to_string()),
                path: Some("/".to_string()),
                secure: Some(true),
                http_only: None,
                same_site: None,
                expires: None,
                priority: None,
                same_party: None,
                source_scheme: None,
                source_port: None,
                partition_key: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cookie_params_parses_header() {
        let header = r#"session-id=000-0000000-0000000; session-token="abc/def=="; x-main="q?uo;ted""#;
        // note: the value with a semicolon inside quotes gets split — Amazon
        // cookie values never contain raw semicolons (they're %-encoded), so a
        // plain split is correct for real headers.
        let params = cookie_params(header);
        assert!(params.iter().any(|c| c.name == "session-id" && c.value == "000-0000000-0000000"));
        let tok = params.iter().find(|c| c.name == "session-token").unwrap();
        assert_eq!(tok.value, r#""abc/def==""#);
        assert!(params.iter().all(|c| c.domain.as_deref() == Some(".amazon.com")));
    }

    #[test]
    fn test_cookie_params_skips_malformed_pairs() {
        let params = cookie_params("good=1; ; =novalue; bare; also-good=2");
        let names: Vec<_> = params.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["good", "also-good"]);
    }
}
