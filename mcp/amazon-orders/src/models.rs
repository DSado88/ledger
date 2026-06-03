use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct OrderSummary {
    pub order_id: String,
    pub date: Option<String>,
    pub total: Option<String>,
    pub ship_to: Option<String>,
    pub status: Option<String>,
    pub status_detail: Option<String>,
    pub subscribe_and_save: bool,
    pub products: Vec<ProductSummary>,
    pub detail_url: String,
    pub invoice_url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProductSummary {
    pub title: Option<String>,
    pub asin: Option<String>,
    pub image_url: Option<String>,
    pub image_hires_url: Option<String>,
    pub return_eligibility: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrderDetail {
    pub order_id: String,
    pub order_date: Option<String>,
    pub shipping_address: Option<String>,
    pub payment_info: Option<String>,
    pub shipments: Vec<Shipment>,
    pub action_links: Vec<ActionLink>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Shipment {
    pub status: Option<String>,
    pub items: Vec<ShipmentItem>,
    pub tracking_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ShipmentItem {
    pub title: Option<String>,
    pub asin: Option<String>,
    pub sold_by: Option<String>,
    pub return_eligibility: Option<String>,
    pub unit_price: Option<String>,
    pub line_total: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Invoice {
    pub order_id: String,
    pub order_date: Option<String>,
    pub ship_to: Option<String>,
    pub payment_methods: Vec<String>,
    pub financials: Vec<FinancialRow>,
    pub line_items: Vec<InvoiceLineItem>,
    pub transactions_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinancialRow {
    pub label: String,
    pub amount: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InvoiceLineItem {
    pub title: Option<String>,
    pub asin: Option<String>,
    pub sold_by: Option<String>,
    pub return_eligibility: Option<String>,
    pub price: Option<String>,
    pub delivery_status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackingInfo {
    pub order_id: String,
    pub tracking_id: Option<String>,
    pub carrier: Option<String>,
    pub status: Option<String>,
    pub promise_message: Option<String>,
    pub delivery_photo_url: Option<String>,
    pub progress: Option<TrackingProgress>,
    pub events: Vec<TrackingEvent>,
    pub embedded_data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackingProgress {
    pub percent_complete: Option<f64>,
    pub last_milestone: Option<String>,
    pub milestones_reached: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackingEvent {
    pub date: Option<String>,
    pub time: Option<String>,
    pub message: Option<String>,
    pub location: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ActionLink {
    pub text: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrimePayment {
    pub date: String,
    pub total: Option<String>,
    pub order_id: Option<String>,
    pub receipt_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FullDump {
    pub scraped_at: String,
    pub filter: String,
    pub orders: Vec<DumpOrder>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DumpOrder {
    pub summary: OrderSummary,
    pub invoice: Option<Invoice>,
}

/// Structured financial breakdown from an Amazon invoice. The critical field is `grand_total`:
/// that is what was actually charged to the credit card. It can be much less than `subtotal`
/// when gift cards, rewards points, or S&S discounts are applied. All amounts are in USD.
/// Negative values represent credits/discounts.
#[derive(Debug, Serialize, Deserialize)]
pub struct InvoiceBreakdown {
    pub subtotal: Option<f64>,
    pub shipping: Option<f64>,
    pub subscribe_and_save_discount: Option<f64>,
    pub promotional_credit: Option<f64>,
    pub total_before_tax: Option<f64>,
    pub tax: Option<f64>,
    pub gift_card: Option<f64>,
    pub rewards_points: Option<f64>,
    pub grand_total: Option<f64>,
    pub refund_total: Option<f64>,
    pub other: Vec<FinancialRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChargeSource {
    Physical,
    Digital,
    Prime,
    Unknown,
}

/// How closely a candidate matched the charge. ExactGrandTotal is the only high-confidence match.
/// ExactOrderTotal means the order list total matched but the invoice wasn't available to confirm
/// the actual card charge (common for digital orders and Prime). FuzzyGrandTotal/FuzzyOrderTotal
/// are within tolerance but not exact -- check amount_diff. NoInvoice means invoice fetch failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchQuality {
    ExactGrandTotal,
    ExactOrderTotal,
    FuzzyGrandTotal,
    FuzzyOrderTotal,
    NoInvoice,
}

/// A reconciliation candidate. Key fields: match_quality tells you confidence level,
/// order_total is the sticker price (what the order page shows), and breakdown.grand_total
/// is what actually hit the card. These differ when gift cards, rewards, or S&S discounts apply.
/// subscribe_and_save=true means the charge date can be weeks after order_date.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReconcileCandidate {
    pub match_quality: MatchQuality,
    pub amount_diff: f64,
    pub source: ChargeSource,
    pub order_id: String,
    pub order_date: Option<String>,
    pub order_total: Option<String>,
    pub subscribe_and_save: bool,
    pub products: Vec<ProductSummary>,
    pub breakdown: Option<InvoiceBreakdown>,
    pub payment_methods: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReconcileResult {
    pub charge_amount: f64,
    pub charge_date: String,
    pub merchant_name: Option<String>,
    pub search_scope: ChargeSource,
    pub candidates: Vec<ReconcileCandidate>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResult {
    /// "already_authenticated" | "authenticated" | "timeout"
    pub status: String,
    pub message: String,
    pub signin_url: String,
    pub elapsed_secs: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReturnSummary {
    pub order_id: Option<String>,
    pub status: Option<String>,
    pub credit_line: Option<String>,
    pub title: Option<String>,
    pub asin: Option<String>,
    pub sold_by: Option<String>,
    pub item_price: Option<String>,
    pub item_attributes: Vec<ItemAttribute>,
    pub status_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ItemAttribute {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Transaction {
    pub date: Option<String>,
    pub payment_method: Option<String>,
    pub amount: Option<String>,
    pub order_id: Option<String>,
    pub is_refund: bool,
    pub merchant: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TransactionList {
    pub order_id: String,
    pub transactions: Vec<Transaction>,
}
