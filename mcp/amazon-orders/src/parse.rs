use std::sync::LazyLock;

use anyhow::Result;
use regex::Regex;
use scraper::{Html, Selector, ElementRef};

use crate::models::*;

static RE_ASIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/dp/([A-Z0-9]{10})").unwrap());
static RE_ORDER_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"orderID=([^&]+)").unwrap());
static RE_ORDER_ID_CI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)orderid=([^&]+)").unwrap());
static RE_RETURN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)Return.*?through\s+[A-Za-z]+\s+\d+,?\s*\d*").unwrap());
static RE_SOLD_BY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Sold by:\s*(.+?)(?:\s*Return|\s*\$|\s*$)").unwrap());
static RE_PRICE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$[\d,.]+").unwrap());
static RE_ORDER_PLACED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Order placed\s+([A-Za-z]+\s+\d+,?\s*\d{4})").unwrap());
static RE_SHIP_TO_US: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Ship to (.+?) United States").unwrap());
static RE_SHIP_TO_PAYMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Ship to (.+?) Payment method").unwrap());

static SEL_BOX_GROUP: LazyLock<Selector> = LazyLock::new(|| sel(".a-box-group"));
static SEL_HREF: LazyLock<Selector> = LazyLock::new(|| sel("a[href]"));
static SEL_HEADER_ITEM: LazyLock<Selector> =
    LazyLock::new(|| sel(".order-header__header-list-item"));
static SEL_AOK_BREAK_WORD: LazyLock<Selector> = LazyLock::new(|| sel(".aok-break-word"));
static SEL_RECIPIENT: LazyLock<Selector> = LazyLock::new(|| sel(".yohtmlc-recipient .a-declarative"));
static SEL_STATUS_PRIMARY: LazyLock<Selector> =
    LazyLock::new(|| sel(".yohtmlc-shipment-status-primaryText"));
static SEL_STATUS_SECONDARY: LazyLock<Selector> =
    LazyLock::new(|| sel(".yohtmlc-shipment-status-secondaryText"));
static SEL_ITEM_BOX: LazyLock<Selector> = LazyLock::new(|| sel(".item-box"));
static SEL_PRODUCT_TITLE: LazyLock<Selector> = LazyLock::new(|| sel(".yohtmlc-product-title"));
static SEL_DP_LINK: LazyLock<Selector> = LazyLock::new(|| sel("a[href*=\"/dp/\"]"));
static SEL_PRODUCT_IMAGE: LazyLock<Selector> = LazyLock::new(|| sel(".product-image img"));
static SEL_HIRES: LazyLock<Selector> = LazyLock::new(|| sel("[data-a-hires]"));
static SEL_BOX: LazyLock<Selector> = LazyLock::new(|| sel(".a-box"));
static SEL_STATUS_ANY: LazyLock<Selector> =
    LazyLock::new(|| sel(".od-status-message, .yohtmlc-shipment-status-primaryText"));
static SEL_FIXED_LEFT_GRID: LazyLock<Selector> = LazyLock::new(|| sel(".a-fixed-left-grid"));
static SEL_ANY_LINK: LazyLock<Selector> = LazyLock::new(|| sel("a"));
static SEL_SHIP_TRACK: LazyLock<Selector> = LazyLock::new(|| sel("a[href*=\"ship-track\"]"));
static SEL_PMTS: LazyLock<Selector> = LazyLock::new(|| sel(".pmts-portal-component"));
static SEL_LINE_ITEM_ROW: LazyLock<Selector> = LazyLock::new(|| sel(".od-line-item-row"));
static SEL_LINE_ITEM_LABEL: LazyLock<Selector> =
    LazyLock::new(|| sel(".od-line-item-row-label"));
static SEL_LINE_ITEM_CONTENT: LazyLock<Selector> =
    LazyLock::new(|| sel(".od-line-item-row-content"));
static SEL_TRANSACTION_LINK: LazyLock<Selector> =
    LazyLock::new(|| sel("a[href*=\"transaction\"]"));
static SEL_CARDUI: LazyLock<Selector> = LazyLock::new(|| sel(".a-cardui"));
static SEL_CARDUI_HEADER_H3: LazyLock<Selector> = LazyLock::new(|| sel(".a-cardui-header h3"));
static SEL_CARDUI_BODY: LazyLock<Selector> = LazyLock::new(|| sel(".a-cardui-body"));
static SEL_TRACKING_ID: LazyLock<Selector> = LazyLock::new(|| sel(".pt-delivery-card-trackingId"));
static SEL_CARRIER_HEADER: LazyLock<Selector> =
    LazyLock::new(|| sel(".tracking-event-carrier-header"));
static SEL_DELIVERY_PHOTO: LazyLock<Selector> = LazyLock::new(|| sel(".photo-on-delivery-img"));
static SEL_EVENT_TIME: LazyLock<Selector> = LazyLock::new(|| sel(".tracking-event-time"));
static SEL_EVENT_MESSAGE: LazyLock<Selector> = LazyLock::new(|| sel(".tracking-event-message"));
static SEL_EVENT_LOCATION: LazyLock<Selector> = LazyLock::new(|| sel(".tracking-event-location"));
static SEL_RETURN_CARD: LazyLock<Selector> = LazyLock::new(|| sel(".item-return-history-card"));
static SEL_RETURN_STATUS: LazyLock<Selector> = LazyLock::new(|| sel(".a-size-medium.a-text-bold"));
static SEL_RETURN_CREDIT: LazyLock<Selector> = LazyLock::new(|| sel(".a-size-base-plus"));
static SEL_RETURN_STATUS_LINK: LazyLock<Selector> = LazyLock::new(|| sel("a[href*=\"returns/prep\"]"));
static SEL_SMALL_TEXT: LazyLock<Selector> = LazyLock::new(|| sel(".a-size-small"));

static RE_TRANSACTION_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})\s*$").unwrap());
static RE_TRANSACTION_AMOUNT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([+-])\$[\d,.]+").unwrap());
static RE_TX_ORDER_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d{3}-\d{7}-\d{7})").unwrap());

fn sel(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}

fn text(el: &ElementRef) -> String {
    el.text().collect::<Vec<_>>().join("\n").trim().to_string()
}

fn first_text(doc: &Html, selector: &Selector) -> Option<String> {
    doc.select(selector).next().map(|el| text(&el)).filter(|s| !s.is_empty())
}

fn attr_val<'a>(el: &'a ElementRef, attr: &str) -> Option<&'a str> {
    el.value().attr(attr)
}

fn extract_asin(href: &str) -> Option<String> {
    RE_ASIN.captures(href).map(|c| c[1].to_string())
}

fn extract_order_id(href: &str) -> Option<String> {
    RE_ORDER_ID.captures(href).map(|c| c[1].to_string())
}

pub fn parse_order_list(html: &str) -> Result<Vec<OrderSummary>> {
    let doc = Html::parse_document(html);
    let mut orders = Vec::new();

    for card in doc.select(&SEL_BOX_GROUP) {
        // Find order ID from any link containing orderID=
        let order_id = card
            .select(&SEL_HREF)
            .filter_map(|a| attr_val(&a, "href").and_then(extract_order_id))
            .next();

        let order_id = match order_id {
            Some(id) => id,
            None => continue,
        };

        // Header fields: date, total, ship-to
        let header_items: Vec<ElementRef> = card
            .select(&SEL_HEADER_ITEM)
            .collect();

        let date = header_items.first().and_then(|item| {
            item.select(&SEL_AOK_BREAK_WORD)
                .next()
                .map(|el| text(&el))
        });

        let total = header_items.get(1).and_then(|item| {
            item.select(&SEL_AOK_BREAK_WORD)
                .next()
                .map(|el| text(&el))
        });

        let ship_to = card
            .select(&SEL_RECIPIENT)
            .next()
            .map(|el| text(&el));

        // Status
        let status = card
            .select(&SEL_STATUS_PRIMARY)
            .next()
            .map(|el| text(&el))
            .filter(|s| !s.is_empty());
        let status_detail = card
            .select(&SEL_STATUS_SECONDARY)
            .next()
            .map(|el| text(&el))
            .filter(|s| !s.is_empty());

        // Products
        let mut products = Vec::new();
        for item_box in card.select(&SEL_ITEM_BOX) {
            let title = item_box
                .select(&SEL_PRODUCT_TITLE)
                .next()
                .map(|el| text(&el));

            let asin = item_box
                .select(&SEL_DP_LINK)
                .next()
                .and_then(|a| attr_val(&a, "href").and_then(extract_asin));

            let image_url = item_box
                .select(&SEL_PRODUCT_IMAGE)
                .next()
                .and_then(|img| attr_val(&img, "src").map(String::from));

            let image_hires_url = item_box
                .select(&SEL_HIRES)
                .next()
                .and_then(|el| attr_val(&el, "data-a-hires").map(String::from));

            let box_text = text(&item_box);
            let return_eligibility = RE_RETURN.find(&box_text).map(|m| m.as_str().to_string());

            if title.is_some() || asin.is_some() {
                products.push(ProductSummary {
                    title,
                    asin,
                    image_url,
                    image_hires_url,
                    return_eligibility,
                });
            }
        }

        let card_text = text(&card);
        let subscribe_and_save = card_text.contains("Subscribe & Save")
            || card_text.contains("Subscribe and Save")
            || card_text.contains("Auto-delivery");

        let base = "https://www.amazon.com";
        orders.push(OrderSummary {
            detail_url: format!("{}/your-orders/order-details?orderID={}", base, order_id),
            invoice_url: format!("{}/gp/css/summary/print.html?orderID={}", base, order_id),
            order_id,
            date,
            total,
            ship_to,
            status,
            status_detail,
            subscribe_and_save,
            products,
        });
    }

    Ok(orders)
}

pub fn has_next_page(html: &str) -> bool {
    html.contains("Next\u{2192}")
        || html.contains("Next&rarr;")
        || html.contains("startIndex=")
}

pub fn parse_order_details(html: &str, order_id: &str) -> Result<OrderDetail> {
    let doc = Html::parse_document(html);

    let order_date = {
        let text_content = doc.root_element().text().collect::<String>();
        RE_ORDER_PLACED.captures(&text_content).map(|c| c[1].to_string())
    };

    // Shipping address
    let shipping_address = {
        let full = doc.root_element().text().collect::<String>();
        let collapsed: String = full.split_whitespace().collect::<Vec<_>>().join(" ");
        RE_SHIP_TO_US.captures(&collapsed).map(|c| c[1].to_string())
            .or_else(|| {
                RE_SHIP_TO_PAYMENT.captures(&collapsed).map(|c| c[1].to_string())
            })
    };

    // Payment
    let payment_info = doc
        .select(&SEL_PMTS)
        .map(|el| text(&el))
        .find(|t| t.len() > 5 && t.len() < 200 && t.contains("ending in"));

    // Shipments from the detail page -- iterate each .a-box that has a status,
    // extracting status + items from within that box.
    let mut shipments = Vec::new();
    for parent in doc.select(&SEL_BOX) {
        let status_el = match parent.select(&SEL_STATUS_ANY).next() {
            Some(el) => el,
            None => continue,
        };
        let status_text = text(&status_el);

        let mut items = Vec::new();
        for grid in parent.select(&SEL_FIXED_LEFT_GRID) {
            let title = grid
                .select(&SEL_DP_LINK)
                .next()
                .map(|a| text(&a))
                .filter(|t| !t.is_empty())
                .or_else(|| {
                    grid.select(&SEL_ANY_LINK)
                        .find(|a| {
                            let t = text(a);
                            t.len() > 10 && !t.contains("Track") && !t.contains("Return")
                        })
                        .map(|a| text(&a))
                });

            let asin = grid
                .select(&SEL_HREF)
                .filter_map(|a| attr_val(&a, "href").and_then(extract_asin))
                .next();

            let grid_text = text(&grid);
            let sold_by = RE_SOLD_BY.captures(&grid_text).map(|c| c[1].trim().to_string());

            let return_eligibility = RE_RETURN.find(&grid_text).map(|m| m.as_str().to_string());

            let prices: Vec<String> = RE_PRICE
                .find_iter(&grid_text)
                .map(|m| m.as_str().to_string())
                .collect();

            if title.is_some() || asin.is_some() {
                items.push(ShipmentItem {
                    title,
                    asin,
                    sold_by,
                    return_eligibility,
                    unit_price: prices.first().cloned(),
                    line_total: prices.get(1).or(prices.first()).cloned(),
                });
            }
        }

        let tracking_url = parent
            .select(&SEL_SHIP_TRACK)
            .next()
            .and_then(|a| attr_val(&a, "href").map(|h| format!("https://www.amazon.com{}", h)));

        if !items.is_empty() || !status_text.is_empty() {
            shipments.push(Shipment {
                status: Some(status_text),
                items,
                tracking_url,
            });
        }
    }

    // Action links
    let action_links: Vec<ActionLink> = doc
        .select(&SEL_HREF)
        .filter(|a| {
            let t = text(a).to_lowercase();
            t.contains("invoice") || t.contains("track") || t.contains("return")
                || t.contains("receipt") || t.contains("view order")
        })
        .filter_map(|a| {
            attr_val(&a, "href").map(|href| ActionLink {
                text: text(&a),
                url: if href.starts_with('/') {
                    format!("https://www.amazon.com{}", href)
                } else {
                    href.to_string()
                },
            })
        })
        .collect();

    Ok(OrderDetail {
        order_id: order_id.to_string(),
        order_date,
        shipping_address,
        payment_info,
        shipments,
        action_links,
    })
}

pub fn parse_invoice(html: &str, order_id: &str) -> Result<Invoice> {
    let doc = Html::parse_document(html);

    let full_text = doc.root_element().text().collect::<String>();

    let order_date = {
        RE_ORDER_PLACED.captures(&full_text).map(|c| c[1].to_string())
    };

    // Shipping address -- collapse whitespace then extract between "Ship to" and "United States"
    let ship_to = {
        let full = doc.root_element().text().collect::<String>();
        let collapsed: String = full.split_whitespace().collect::<Vec<_>>().join(" ");
        RE_SHIP_TO_US.captures(&collapsed).map(|c| c[1].to_string())
            .or_else(|| {
                RE_SHIP_TO_PAYMENT.captures(&collapsed).map(|c| c[1].to_string())
            })
    };

    // Financial rows
    let mut financials = Vec::new();
    for row in doc.select(&SEL_LINE_ITEM_ROW) {
        let label = row
            .select(&SEL_LINE_ITEM_LABEL)
            .next()
            .map(|el| text(&el))
            .unwrap_or_default();
        let amount = row
            .select(&SEL_LINE_ITEM_CONTENT)
            .next()
            .map(|el| text(&el))
            .unwrap_or_default();

        if !label.is_empty() && !amount.is_empty() {
            financials.push(FinancialRow { label, amount });
        }
    }

    // Payment methods
    let payment_methods: Vec<String> = doc
        .select(&SEL_PMTS)
        .map(|el| text(&el))
        .filter(|t| t.len() > 5 && t.len() < 200 && !t.contains("View all"))
        .collect();

    // Line items from shipment blocks
    let mut line_items = Vec::new();
    for grid in doc.select(&SEL_FIXED_LEFT_GRID) {
        let asin_link = grid.select(&SEL_DP_LINK).next();
        let asin = asin_link.and_then(|a| attr_val(&a, "href").and_then(extract_asin));

        // Get title from the product link (not the image link)
        let title = grid
            .select(&SEL_DP_LINK)
            .find(|a| {
                let t = text(a);
                t.len() > 5
            })
            .map(|a| text(&a));

        let grid_text = text(&grid);

        let sold_by = RE_SOLD_BY.captures(&grid_text).map(|c| c[1].trim().to_string());

        let return_eligibility = RE_RETURN.find(&grid_text).map(|m| m.as_str().to_string());

        let price = RE_PRICE.find(&grid_text).map(|m| m.as_str().to_string());

        // Find delivery status from the nearest od-status-message ancestor
        let delivery_status = None; // Would need parent traversal

        if title.is_some() || asin.is_some() {
            line_items.push(InvoiceLineItem {
                title,
                asin,
                sold_by,
                return_eligibility,
                price,
                delivery_status,
            });
        }
    }

    // Transactions URL
    let transactions_url = doc
        .select(&SEL_TRANSACTION_LINK)
        .next()
        .and_then(|a| attr_val(&a, "href").map(String::from));

    Ok(Invoice {
        order_id: order_id.to_string(),
        order_date,
        ship_to,
        payment_methods,
        financials,
        line_items,
        transactions_url,
    })
}

pub fn parse_tracking(html: &str, order_id: &str) -> Result<TrackingInfo> {
    let doc = Html::parse_document(html);

    // Extract embedded JSON from script tags
    let embedded_data = extract_tracking_json(html);

    let tracking_id = first_text(&doc, &SEL_TRACKING_ID)
        .map(|t| t.replace("Tracking ID:", "").trim().to_string());

    let carrier = first_text(&doc, &SEL_CARRIER_HEADER);

    let delivery_photo_url = doc
        .select(&SEL_DELIVERY_PHOTO)
        .next()
        .and_then(|img| attr_val(&img, "src").map(String::from))
        .filter(|url| !url.contains("grey-pixel"));

    // Extract status and promise from embedded JSON if available
    let (status, promise_message, progress) = if let Some(ref data) = embedded_data {
        let status = data.get("shortStatus").and_then(|v| v.as_str()).map(String::from);
        let promise = data
            .get("promise")
            .and_then(|p| p.get("promiseMessage"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let prog = data.get("progressTracker").map(|pt| TrackingProgress {
            percent_complete: pt.get("lastTransitionPercentComplete").and_then(|v| v.as_f64()),
            last_milestone: pt.get("lastReachedMilestone").and_then(|v| v.as_str()).map(String::from),
            milestones_reached: pt.get("numberOfReachedMilestones").and_then(|v| v.as_u64()).map(|v| v as u32),
        });
        (status, promise, prog)
    } else {
        (None, None, None)
    };

    // Tracking events from DOM -- walk all children, tracking the current
    // date header so events inherit the most recent header above them.
    let mut events = Vec::new();
    let mut current_date: Option<String> = None;
    let sel_header_or_event = sel(".tracking-event-date-header, .tracking-event-date");

    for el in doc.select(&sel_header_or_event) {
        let classes = el.value().attr("class").unwrap_or("");
        if classes.contains("tracking-event-date-header") {
            current_date = Some(text(&el));
            continue;
        }

        let time = el
            .select(&SEL_EVENT_TIME)
            .next()
            .map(|el| text(&el));
        let message = el
            .select(&SEL_EVENT_MESSAGE)
            .next()
            .map(|el| text(&el));
        let location = el
            .select(&SEL_EVENT_LOCATION)
            .next()
            .map(|el| text(&el));

        if message.is_some() || time.is_some() {
            events.push(TrackingEvent {
                date: current_date.clone(),
                time,
                message,
                location,
            });
        }
    }

    Ok(TrackingInfo {
        order_id: order_id.to_string(),
        tracking_id,
        carrier,
        status,
        promise_message,
        delivery_photo_url,
        progress,
        events,
        embedded_data,
    })
}

static RE_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z]+\s+\d{1,2},?\s*\d{4}$").unwrap());
static RE_DIGITAL_ORDER_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"D\d{2}-\d{7}-\d{7}").unwrap());

pub fn parse_prime_payments(html: &str) -> Result<Vec<PrimePayment>> {
    let doc = Html::parse_document(html);
    let mut payments = Vec::new();

    for card in doc.select(&SEL_CARDUI) {
        let date = match card.select(&SEL_CARDUI_HEADER_H3).next() {
            Some(h3) => text(&h3),
            None => continue,
        };

        if !RE_DATE.is_match(&date) {
            continue;
        }

        let body = match card.select(&SEL_CARDUI_BODY).next() {
            Some(b) => b,
            None => continue,
        };

        let body_text = text(&body);

        let total = RE_PRICE.find(&body_text).map(|m| m.as_str().to_string());
        let order_id = RE_DIGITAL_ORDER_ID.find(&body_text).map(|m| m.as_str().to_string());
        let receipt_url = body.select(&SEL_HREF).find(|a| {
            text(a).contains("Receipt")
        }).and_then(|a| attr_val(&a, "href").map(|h| {
            if h.starts_with('/') { format!("https://www.amazon.com{}", h) } else { h.to_string() }
        }));

        payments.push(PrimePayment { date, total, order_id, receipt_url });
    }

    Ok(payments)
}

pub fn parse_dollar(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let negative = s.starts_with('-');
    let cleaned: String = s.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    if cleaned.is_empty() {
        return None;
    }
    let val = cleaned.parse::<f64>().ok()?;
    Some(if negative { -val } else { val })
}

pub fn extract_breakdown(rows: &[FinancialRow]) -> InvoiceBreakdown {
    let mut bd = InvoiceBreakdown {
        subtotal: None,
        shipping: None,
        subscribe_and_save_discount: None,
        promotional_credit: None,
        total_before_tax: None,
        tax: None,
        gift_card: None,
        rewards_points: None,
        grand_total: None,
        refund_total: None,
        other: Vec::new(),
    };

    for row in rows {
        let label = row.label.trim().trim_end_matches(':');
        let amount = parse_dollar(&row.amount);
        match label {
            "Item(s) Subtotal" => bd.subtotal = amount,
            "Shipping & Handling" => bd.shipping = amount,
            "Free Shipping" => {
                bd.shipping = Some(bd.shipping.unwrap_or(0.0) + amount.unwrap_or(0.0));
            }
            "Subscribe & Save" => bd.subscribe_and_save_discount = amount,
            "Your Coupon Savings" | "Promotional credit" => {
                bd.promotional_credit = Some(bd.promotional_credit.unwrap_or(0.0) + amount.unwrap_or(0.0));
            }
            "Total before tax" => bd.total_before_tax = amount,
            "Estimated tax to be collected" => bd.tax = amount,
            "Gift Card Amount" => bd.gift_card = amount,
            "Rewards Points" => bd.rewards_points = amount,
            "Grand Total" => bd.grand_total = amount,
            "Refund Total" => bd.refund_total = amount,
            _ => bd.other.push(row.clone()),
        }
    }

    bd
}

pub fn classify_merchant(merchant_name: &str) -> ChargeSource {
    let lower = merchant_name.to_lowercase();
    if lower.contains("prime") {
        ChargeSource::Prime
    } else if lower.contains("digit")
        || lower.contains("kindle")
        || lower.contains("audible")
        || lower.contains("music unlimited")
    {
        ChargeSource::Digital
    } else if lower.contains("amzn mktp")
        || lower.contains("amazon.com")
        || lower.contains("amzn.com")
    {
        ChargeSource::Physical
    } else {
        ChargeSource::Unknown
    }
}

pub fn parse_date_to_ymd(date_str: &str) -> Option<chrono::NaiveDate> {
    if let Ok(d) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        return Some(d);
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(date_str, "%B %d, %Y") {
        return Some(d);
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(date_str, "%B %d %Y") {
        return Some(d);
    }
    None
}

fn extract_tracking_json(html: &str) -> Option<serde_json::Value> {
    // Find the script content containing shortStatus
    let marker = "\"shortStatus\"";
    let pos = html.find(marker)?;

    // Candidate opening braces are every '{' before the marker, tried from the
    // nearest backward outward, so we recover even if an outer object isn't
    // balanced or an inner one is the real payload.
    let before = &html[..pos];
    let mut candidates: Vec<usize> = before.match_indices('{').map(|(i, _)| i).collect();
    candidates.reverse();

    for start in candidates {
        if let Some(end) = matching_brace_end(&html[start..]) {
            let candidate = &html[start..start + end];
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                // Only accept if it actually carries the field we were after.
                if value.get("shortStatus").is_some() {
                    return Some(value);
                }
            }
        }
    }

    None
}

// Returns the byte offset just past the brace that closes the object starting
// at index 0 of `slice` (which must begin with '{'), respecting JSON string
// literals so that braces inside strings are ignored.
fn matching_brace_end(slice: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;

    for (i, ch) in slice.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }

    None
}

pub fn parse_returns(html: &str) -> Result<Vec<ReturnSummary>> {
    let doc = Html::parse_document(html);
    let mut returns = Vec::new();

    for card in doc.select(&SEL_RETURN_CARD) {
        let status = card.select(&SEL_RETURN_STATUS).next().map(|el| text(&el));
        let credit_line = card.select(&SEL_RETURN_CREDIT).next().map(|el| text(&el));

        let product_link = card.select(&SEL_DP_LINK).next();
        let title = product_link.as_ref().and_then(|a| {
            let t = text(a);
            if t.len() > 5 { Some(t) } else { None }
        });
        let asin = product_link.and_then(|a| attr_val(&a, "href").and_then(extract_asin));

        let status_url = card.select(&SEL_RETURN_STATUS_LINK).next()
            .and_then(|a| attr_val(&a, "href").map(|h| {
                if h.starts_with('/') { format!("https://www.amazon.com{}", h) } else { h.to_string() }
            }));

        let order_id = status_url.as_deref()
            .and_then(|u| RE_ORDER_ID_CI.captures(u))
            .map(|c| c[1].to_string());

        // Extract small text pairs (label: value)
        let small_spans: Vec<String> = card.select(&SEL_SMALL_TEXT).map(|el| text(&el)).collect();
        let mut sold_by = None;
        let mut item_price = None;
        let mut attributes = Vec::new();

        let mut i = 0;
        while i < small_spans.len() {
            let span_text = &small_spans[i];
            if span_text.ends_with(':') {
                let key = span_text.trim_end_matches(':').to_string();
                if i + 1 < small_spans.len() {
                    let val = small_spans[i + 1].clone();
                    match key.as_str() {
                        "Sold by" => sold_by = Some(val),
                        "Item price" => item_price = Some(val),
                        _ => attributes.push(ItemAttribute { name: key, value: val }),
                    }
                    i += 2;
                    continue;
                }
            }
            i += 1;
        }

        returns.push(ReturnSummary {
            order_id,
            status,
            credit_line,
            title,
            asin,
            sold_by,
            item_price,
            item_attributes: attributes,
            status_url,
        });
    }

    Ok(returns)
}

pub fn parse_transactions(html: &str, order_id: &str) -> Result<TransactionList> {
    let doc = Html::parse_document(html);
    let full_text = doc.root_element().text().collect::<Vec<_>>().join("\n");

    let mut transactions = Vec::new();
    let mut current_date: Option<String> = None;

    // Split the text into lines and walk through looking for transaction patterns
    let lines: Vec<&str> = full_text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];

        // Check if this is a date line
        if RE_TRANSACTION_DATE.is_match(line) {
            current_date = Some(line.to_string());
            i += 1;
            continue;
        }

        // Check if this line contains a payment method pattern (e.g. "Prime Visa ****6155")
        if line.contains("****") || line.contains("ending in") {
            let payment_method = Some(line.to_string());

            // Look ahead for amount, order link, merchant
            let mut amount = None;
            let mut is_refund = false;
            let mut tx_order_id = None;
            let mut merchant = None;

            let lookahead = (i + 1)..std::cmp::min(i + 6, lines.len());
            for j in lookahead {
                let next = lines[j];
                if next.contains("****") || RE_TRANSACTION_DATE.is_match(next) {
                    break;
                }
                if RE_TRANSACTION_AMOUNT.is_match(next) {
                    amount = Some(next.to_string());
                    is_refund = next.starts_with('+');
                }
                if next.starts_with("Order #") || next.starts_with("Refund: Order #") || next.starts_with("Refund:") {
                    is_refund = is_refund || next.contains("Refund");
                    // Extract order ID from "Order #111-..." or "Refund: Order #111-..."
                    if let Some(cap) = RE_TX_ORDER_ID.captures(next) {
                        tx_order_id = Some(cap[1].to_string());
                    }
                }
                if next.starts_with("AMZN") || next.starts_with("Amazon") {
                    merchant = Some(next.to_string());
                }
            }

            transactions.push(Transaction {
                date: current_date.clone(),
                payment_method,
                amount,
                order_id: tx_order_id,
                is_refund,
                merchant,
            });
        }

        i += 1;
    }

    Ok(TransactionList {
        order_id: order_id.to_string(),
        transactions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_tracking_json_with_braces_in_strings() {
        let html = r#"<script>var data = {"orderId":"111","shortStatus":"DELIVERED","promise":{"promiseMessage":"Arriving today :}"},"progressTracker":{"lastTransitionPercentComplete":100}}</script>"#;
        let result = extract_tracking_json(html);
        assert!(result.is_some(), "should extract JSON even with braces in string values");
        let json = result.unwrap();
        assert_eq!(json["shortStatus"], "DELIVERED");
        assert_eq!(json["promise"]["promiseMessage"], "Arriving today :}");
        assert_eq!(json["progressTracker"]["lastTransitionPercentComplete"], 100);
    }

    #[test]
    fn test_multi_shipment_order_details() {
        let html = r#"<html><body>
        <div class="a-box">
            <div class="yohtmlc-shipment-status-primaryText">Delivered May 14</div>
            <div class="a-fixed-left-grid">
                <a href="/dp/B0DG5HMVZF">Dog Treats</a>
                <span>Sold by: PetCo</span>
            </div>
        </div>
        <div class="a-box">
            <div class="yohtmlc-shipment-status-primaryText">Delivered May 15</div>
            <div class="a-fixed-left-grid">
                <a href="/dp/B0FCMR4BC2">Cookie Cutters</a>
                <span>Sold by: BakeCo</span>
            </div>
        </div>
        </body></html>"#;
        let result = parse_order_details(html, "111-0000000-0000000").unwrap();
        assert_eq!(result.shipments.len(), 2);
        assert_eq!(result.shipments[0].items.len(), 1);
        assert_eq!(result.shipments[0].items[0].asin.as_deref(), Some("B0DG5HMVZF"));
        assert_eq!(result.shipments[1].items.len(), 1);
        assert_eq!(result.shipments[1].items[0].asin.as_deref(), Some("B0FCMR4BC2"));
    }

    #[test]
    fn test_sold_by_extraction() {
        // Minified HTML (no whitespace between tags) is the case that triggered
        // the overcapture: text nodes join with no boundary between fields.
        let html = r#"<html><body><div class="a-fixed-left-grid"><a href="/dp/B0GP2QWJ8W">Dog Biscuits</a><span>Sold by: PetShop Inc</span><span>Return items: Eligible through June 13, 2026</span><span>$12.99</span></div></body></html>"#;
        let result = parse_invoice(html, "111-0000000-0000000").unwrap();
        assert_eq!(result.line_items.len(), 1);
        let sold_by = result.line_items[0].sold_by.as_deref().unwrap();
        assert_eq!(sold_by, "PetShop Inc");
        assert!(!sold_by.contains("Return"), "sold_by should not contain return eligibility text");
    }

    #[test]
    fn test_parse_prime_payments() {
        let html = r#"<html><body>
        <div class="a-cardui">
            <div class="a-cardui-header"><h3 class="a-size-base">April 30, 2026</h3></div>
            <div class="a-cardui-body">
                <span class="a-color-tertiary">Total</span>
                <p class="a-nowrap">$147.34</p>
                <span class="a-color-tertiary">Order Number</span>
                <p class="a-nowrap">D01-3916038-5017866</p>
                <a href="/gp/digital/your-account/order-summary.html?orderID=D01-3916038-5017866&amp;print=1">View Receipt</a>
            </div>
        </div>
        <div class="a-cardui">
            <div class="a-cardui-header"><h3 class="a-size-base">April 30, 2021</h3></div>
            <div class="a-cardui-body">
                <span class="a-color-tertiary">Total</span>
                <p class="a-nowrap">$119.00</p>
                <span class="a-color-tertiary">Order Number</span>
                <p class="a-nowrap">D01-6073877-5401810</p>
                <a href="/gp/digital/your-account/order-summary.html?orderID=D01-6073877-5401810&amp;print=1">View Receipt</a>
            </div>
        </div>
        <div class="a-cardui">
            <div class="a-cardui-header"><h3>Not a date</h3></div>
            <div class="a-cardui-body">should be skipped</div>
        </div>
        </body></html>"#;

        let payments = parse_prime_payments(html).unwrap();
        assert_eq!(payments.len(), 2, "must parse 2 payment cards and skip non-date card");
        assert_eq!(payments[0].date, "April 30, 2026");
        assert_eq!(payments[0].total.as_deref(), Some("$147.34"));
        assert_eq!(payments[0].order_id.as_deref(), Some("D01-3916038-5017866"));
        assert!(payments[0].receipt_url.as_deref().unwrap().contains("order-summary.html"));
        assert_eq!(payments[1].date, "April 30, 2021");
        assert_eq!(payments[1].total.as_deref(), Some("$119.00"));
    }

    #[test]
    fn test_parse_digital_order_list() {
        let html = r#"<html><body>
        <div class="a-box-group a-spacing-base">
            <div class="order-header__header-list-item">
                <span class="aok-break-word">April 30, 2026</span>
            </div>
            <div class="order-header__header-list-item">
                <span class="aok-break-word">$12.71</span>
            </div>
            <a href="/your-orders/order-details?orderID=D01-6065648-9206659">View order details</a>
            <div class="item-box">
                <a class="yohtmlc-product-title" href="/dp/B09W897871">Amazon Music Unlimited</a>
                <div class="product-image"><img src="https://example.com/music.png" /></div>
            </div>
        </div>
        <div class="a-box-group a-spacing-base">
            <div class="order-header__header-list-item">
                <span class="aok-break-word">March 27, 2026</span>
            </div>
            <div class="order-header__header-list-item">
                <span class="aok-break-word">$11.65</span>
            </div>
            <a href="/your-orders/order-details?orderID=D01-3205040-1302627">View order details</a>
            <div class="item-box">
                <a class="yohtmlc-product-title" href="/dp/B09W897871">Amazon Music Unlimited</a>
            </div>
        </div>
        </body></html>"#;

        let orders = parse_order_list(html).unwrap();
        assert_eq!(orders.len(), 2, "must parse digital order cards");
        assert_eq!(orders[0].order_id, "D01-6065648-9206659");
        assert_eq!(orders[0].date.as_deref(), Some("April 30, 2026"));
        assert_eq!(orders[0].total.as_deref(), Some("$12.71"));
        assert_eq!(orders[0].products.len(), 1);
        assert_eq!(orders[0].products[0].title.as_deref(), Some("Amazon Music Unlimited"));
        assert_eq!(orders[0].products[0].asin.as_deref(), Some("B09W897871"));
        assert!(orders[0].ship_to.is_none(), "digital orders have no ship_to");
        assert_eq!(orders[1].order_id, "D01-3205040-1302627");
        assert_eq!(orders[1].total.as_deref(), Some("$11.65"));
    }

    #[test]
    fn test_has_next_page() {
        assert!(has_next_page("<a>Next\u{2192}</a>"));
        assert!(has_next_page(r#"<a class="next">Next&rarr;</a>"#));
        assert!(!has_next_page("<div>no pagination here</div>"));
        // Real Amazon HTML: spans between "Next" and arrow
        assert!(has_next_page(
            r#"<a href="/orders?startIndex=10">Next<span class="a-letter-space"></span><span class="a-letter-space"></span>→</a>"#
        ), "must match Next with interleaved spans before arrow");
    }

    #[test]
    fn test_return_eligibility_across_elements() {
        let html = r#"<html><body>
        <div class="a-fixed-left-grid">
            <a href="/dp/B0GP2QWJ8W">Dog Biscuits</a>
            <span>Sold by: PetShop</span>
            <span>Return items:</span>
            <span>Eligible through June 13, 2026</span>
            <span>$12.99</span>
        </div>
        </body></html>"#;
        let result = parse_invoice(html, "111-0000000-0000000").unwrap();
        assert_eq!(result.line_items.len(), 1);
        let ret = result.line_items[0].return_eligibility.as_deref();
        assert!(ret.is_some(), "return_eligibility must be extracted when text spans elements");
        assert!(ret.unwrap().contains("through"), "must contain 'through'");
    }

    #[test]
    fn test_tracking_events_date_grouping() {
        let html = r#"<html><body>
        <div class="tracking-event-date-header">Wednesday, May 14</div>
        <div class="tracking-event-date">
            <span class="tracking-event-time">3:45 PM</span>
            <span class="tracking-event-message">Delivered</span>
            <span class="tracking-event-location">Front door</span>
        </div>
        <div class="tracking-event-date">
            <span class="tracking-event-time">10:30 AM</span>
            <span class="tracking-event-message">Out for delivery</span>
            <span class="tracking-event-location">Nearby</span>
        </div>
        <div class="tracking-event-date-header">Tuesday, May 13</div>
        <div class="tracking-event-date">
            <span class="tracking-event-time">8:00 PM</span>
            <span class="tracking-event-message">Arrived at facility</span>
            <span class="tracking-event-location">Warehouse</span>
        </div>
        </body></html>"#;
        let result = parse_tracking(html, "111-0000000-0000000").unwrap();
        assert_eq!(result.events.len(), 3);
        assert_eq!(result.events[0].date.as_deref(), Some("Wednesday, May 14"));
        assert_eq!(result.events[1].date.as_deref(), Some("Wednesday, May 14"),
            "second event should share first date header, not get the second one");
        assert_eq!(result.events[2].date.as_deref(), Some("Tuesday, May 13"));
    }

    #[test]
    fn test_parse_dollar() {
        assert_eq!(parse_dollar("$42.74"), Some(42.74));
        assert_eq!(parse_dollar("-$4.80"), Some(-4.80));
        assert_eq!(parse_dollar("$1,234.56"), Some(1234.56));
        assert_eq!(parse_dollar("$0.00"), Some(0.0));
        assert_eq!(parse_dollar("-$271.89"), Some(-271.89));
        assert!(parse_dollar("").is_none());
        assert!(parse_dollar("N/A").is_none());
    }

    #[test]
    fn test_extract_breakdown_basic() {
        let rows = vec![
            FinancialRow { label: "Item(s) Subtotal:".into(), amount: "$47.99".into() },
            FinancialRow { label: "Shipping & Handling:".into(), amount: "$0.00".into() },
            FinancialRow { label: "Subscribe & Save:".into(), amount: "-$4.80".into() },
            FinancialRow { label: "Promotional credit:".into(), amount: "-$0.45".into() },
            FinancialRow { label: "Total before tax:".into(), amount: "$42.74".into() },
            FinancialRow { label: "Estimated tax to be collected:".into(), amount: "$0.00".into() },
            FinancialRow { label: "Grand Total:".into(), amount: "$42.74".into() },
        ];
        let bd = extract_breakdown(&rows);
        assert_eq!(bd.subtotal, Some(47.99));
        assert_eq!(bd.shipping, Some(0.0));
        assert_eq!(bd.subscribe_and_save_discount, Some(-4.80));
        assert_eq!(bd.promotional_credit, Some(-0.45));
        assert_eq!(bd.total_before_tax, Some(42.74));
        assert_eq!(bd.tax, Some(0.0));
        assert_eq!(bd.grand_total, Some(42.74));
        assert!(bd.gift_card.is_none());
        assert!(bd.other.is_empty());
    }

    #[test]
    fn test_extract_breakdown_with_offsets() {
        let rows = vec![
            FinancialRow { label: "Item(s) Subtotal:".into(), amount: "$359.99".into() },
            FinancialRow { label: "Total before tax:".into(), amount: "$359.99".into() },
            FinancialRow { label: "Estimated tax to be collected:".into(), amount: "$21.60".into() },
            FinancialRow { label: "Gift Card Amount:".into(), amount: "-$271.89".into() },
            FinancialRow { label: "Rewards Points:".into(), amount: "-$25.36".into() },
            FinancialRow { label: "Grand Total:".into(), amount: "$84.34".into() },
        ];
        let bd = extract_breakdown(&rows);
        assert_eq!(bd.gift_card, Some(-271.89));
        assert_eq!(bd.rewards_points, Some(-25.36));
        assert_eq!(bd.grand_total, Some(84.34));
        assert_eq!(bd.tax, Some(21.60));
    }

    #[test]
    fn test_extract_breakdown_unknown_labels() {
        let rows = vec![
            FinancialRow { label: "Item(s) Subtotal:".into(), amount: "$10.00".into() },
            FinancialRow { label: "Some Future Discount:".into(), amount: "-$2.00".into() },
            FinancialRow { label: "Grand Total:".into(), amount: "$8.00".into() },
        ];
        let bd = extract_breakdown(&rows);
        assert_eq!(bd.other.len(), 1);
        assert_eq!(bd.other[0].label, "Some Future Discount:");
    }

    #[test]
    fn test_classify_merchant() {
        assert_eq!(classify_merchant("AMZN MKTP US"), ChargeSource::Physical);
        assert_eq!(classify_merchant("AMZN Mktp US*AB1CD2EF3"), ChargeSource::Physical);
        assert_eq!(classify_merchant("Amazon.com*BV3XN9B12"), ChargeSource::Physical);
        assert_eq!(classify_merchant("Amazon Digit*5W2IJ4223"), ChargeSource::Digital);
        assert_eq!(classify_merchant("Kindle Unlimited"), ChargeSource::Digital);
        assert_eq!(classify_merchant("Audible US"), ChargeSource::Digital);
        assert_eq!(classify_merchant("Amazon Prime*AB1234"), ChargeSource::Prime);
        assert_eq!(classify_merchant("RANDOM MERCHANT"), ChargeSource::Unknown);
    }

    #[test]
    fn test_parse_date_to_ymd() {
        assert_eq!(
            parse_date_to_ymd("2026-05-20"),
            Some(chrono::NaiveDate::from_ymd_opt(2026, 5, 20).unwrap())
        );
        assert_eq!(
            parse_date_to_ymd("May 20, 2026"),
            Some(chrono::NaiveDate::from_ymd_opt(2026, 5, 20).unwrap())
        );
        assert_eq!(
            parse_date_to_ymd("May 8, 2026"),
            Some(chrono::NaiveDate::from_ymd_opt(2026, 5, 8).unwrap())
        );
        assert!(parse_date_to_ymd("garbage").is_none());
    }
}
