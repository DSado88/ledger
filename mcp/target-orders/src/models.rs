use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct OrderHistoryResponse {
    pub metadata: Option<Metadata>,
    pub guest_id: Option<String>,
    pub total_orders: Option<u32>,
    pub total_pages: Option<u32>,
    #[serde(default)]
    pub orders: Vec<Order>,
    pub request: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Metadata {
    pub total_time: Option<u64>,
    pub guest_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Order {
    pub placed_date: Option<String>,
    pub order_type: Option<String>,
    pub summary: Option<OrderSummary>,
    pub address: Option<Vec<Address>>,
    pub order_lines: Option<Vec<OrderLine>>,
    pub order_purchase_type: Option<String>,
    pub store_receipt_id: Option<String>,
    pub store_id: Option<String>,
    pub order_id: Option<String>,
    pub is_more_lines: Option<bool>,
    pub pending_returns: Option<bool>,
    pub has_adult_beverage_items: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrderSummary {
    pub grand_total: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Address {
    pub first_name: Option<String>,
    pub address_line1: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub zip_code: Option<String>,
    pub country: Option<String>,
    pub phone_number: Option<String>,
    #[serde(rename = "type")]
    pub address_type: Option<String>,
    pub store_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrderLine {
    pub line_number: Option<u32>,
    pub original_quantity: Option<u32>,
    pub grouping: Option<Grouping>,
    pub item: Option<Item>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Grouping {
    pub key: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Item {
    pub tcin: Option<String>,
    pub description: Option<String>,
    pub images: Option<ItemImages>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ItemImages {
    pub base_url: Option<String>,
    pub primary_image: Option<String>,
    pub alternate_images: Option<Vec<String>>,
}
