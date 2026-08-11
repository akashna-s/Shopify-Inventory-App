import React, { useState, useMemo } from "react";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import * as XLSX from "xlsx";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  try {
    const response = await admin.graphql(
      `#graphql
      query getOrdersAndShop {
        shop {
          currencyCode
          name
        }
        orders(first: 250, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              processedAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalTaxSet {
                shopMoney {
                  amount
                }
              }
              customer {
                displayName
                email
              }
              lineItems(first: 20) {
                edges {
                  node {
                    id
                    title
                    quantity
                  }
                }
              }
            }
          }
        }
      }`
    );

    const responseJson = await response.json();

    if (responseJson.errors) {
      console.error("GraphQL errors fetching orders:", responseJson.errors);
      return {
        orders: [],
        shopCurrency: "USD",
        error: responseJson.errors[0]?.message || "Failed to load orders.",
      };
    }

    const shopCurrency = responseJson.data?.shop?.currencyCode || "USD";
    const rawOrders = responseJson.data?.orders?.edges?.map((edge) => edge.node) || [];

    const orders = rawOrders.map((order) => {
      const lineItemSummary =
        order.lineItems?.edges
          ?.map((e) => `${e.node.title} (x${e.node.quantity})`)
          .join(", ") || "No items";
      const totalItemCount =
        order.lineItems?.edges?.reduce((acc, e) => acc + (e.node.quantity || 0), 0) || 0;

      return {
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        date: order.createdAt ? order.createdAt.split("T")[0] : "",
        customerName: order.customer?.displayName || "Guest Customer",
        customerEmail: order.customer?.email || "N/A",
        financialStatus: order.displayFinancialStatus || "PENDING",
        fulfillmentStatus: order.displayFulfillmentStatus || "UNFULFILLED",
        totalPrice: parseFloat(order.totalPriceSet?.shopMoney?.amount || "0"),
        currency: order.totalPriceSet?.shopMoney?.currencyCode || shopCurrency,
        totalTax: parseFloat(order.totalTaxSet?.shopMoney?.amount || "0"),
        itemsSummary: lineItemSummary,
        itemCount: totalItemCount,
      };
    });

    return { orders, shopCurrency, error: null };
  } catch (err) {
    console.error("Error loading orders:", err);
    return { orders: [], shopCurrency: "USD", error: err.message || "Failed to fetch order data." };
  }
};

// Helper date utilities
function getIsoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

function getWeekRangeLabel(dateStr) {
  if (!dateStr) return "Unknown Week";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Unknown Week";
  
  const day = d.getDay();
  const diffToMonday = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diffToMonday));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const format = (date) =>
    date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Week ${getIsoWeek(monday)} (${format(monday)} - ${format(sunday)}, ${monday.getFullYear()})`;
}

function getMonthLabel(dateStr) {
  if (!dateStr) return "Unknown Month";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Unknown Month";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function getDayLabel(dateStr) {
  if (!dateStr) return "Unknown Date";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Unknown Date";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatCurrency(amount, currencyCode = "USD") {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount || 0);
  } catch (e) {
    return `${currencyCode || "USD"} ${parseFloat(amount || 0).toFixed(2)}`;
  }
}

// Sample fallback orders for visual testing when store has 0 orders
const SAMPLE_ORDERS = [
  {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    createdAt: "2026-07-30T10:15:00Z",
    date: "2026-07-30",
    customerName: "Alice Smith",
    customerEmail: "alice@example.com",
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    totalPrice: 149.99,
    currency: "USD",
    totalTax: 12.0,
    itemsSummary: "Snowboard Bindings (x1), Thermal Socks (x2)",
    itemCount: 3,
  },
  {
    id: "gid://shopify/Order/1002",
    name: "#1002",
    createdAt: "2026-07-30T14:22:00Z",
    date: "2026-07-30",
    customerName: "Bob Johnson",
    customerEmail: "bob@example.com",
    financialStatus: "PAID",
    fulfillmentStatus: "UNFULFILLED",
    totalPrice: 89.5,
    currency: "USD",
    totalTax: 7.15,
    itemsSummary: "Hydrogen Snowboard Wax (x3)",
    itemCount: 3,
  },
  {
    id: "gid://shopify/Order/1003",
    name: "#1003",
    createdAt: "2026-07-28T09:05:00Z",
    date: "2026-07-28",
    customerName: "Charlie Brown",
    customerEmail: "charlie@example.com",
    financialStatus: "PENDING",
    fulfillmentStatus: "UNFULFILLED",
    totalPrice: 299.0,
    currency: "USD",
    totalTax: 23.92,
    itemsSummary: "Pro Alpine Helmet (x1)",
    itemCount: 1,
  },
  {
    id: "gid://shopify/Order/1004",
    name: "#1004",
    createdAt: "2026-07-22T16:40:00Z",
    date: "2026-07-22",
    customerName: "Diana Prince",
    customerEmail: "diana@example.com",
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    totalPrice: 420.0,
    currency: "USD",
    totalTax: 33.6,
    itemsSummary: "All-Mountain Snowboard (x1)",
    itemCount: 1,
  },
  {
    id: "gid://shopify/Order/1005",
    name: "#1005",
    createdAt: "2026-06-15T11:10:00Z",
    date: "2026-06-15",
    customerName: "Evan Wright",
    customerEmail: "evan@example.com",
    financialStatus: "REFUNDED",
    fulfillmentStatus: "UNFULFILLED",
    totalPrice: 65.0,
    currency: "USD",
    totalTax: 5.2,
    itemsSummary: "Winter Beanie (x2)",
    itemCount: 2,
  },
];

export default function OrderDetails() {
  const loaderData = useLoaderData();
  const realOrders = loaderData?.orders || [];
  const shopCurrency = loaderData?.shopCurrency || "USD";
  const errorMsg = loaderData?.error;

  // Map sample orders to use actual shop currency when sample data is shown
  const sampleOrdersWithShopCurrency = useMemo(() => {
    return SAMPLE_ORDERS.map((o) => ({ ...o, currency: shopCurrency }));
  }, [shopCurrency]);

  // Use real orders if present, fallback to sample data if 0 orders present for demonstration
  const [useSampleData, setUseSampleData] = useState(realOrders.length === 0);
  const activeOrders = useSampleData ? sampleOrdersWithShopCurrency : realOrders;

  // Filters state
  const [grouping, setGrouping] = useState("daily"); // 'daily' | 'weekly' | 'monthly'
  const [searchQuery, setSearchQuery] = useState("");
  const [financialFilter, setFinancialFilter] = useState("ALL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [expandedGroup, setExpandedGroup] = useState(null);

  // Filtered orders
  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const qNumeric = q.replace(/\D/g, "");

    return activeOrders.filter((order) => {
      // Search filter
      let matchesSearch = !q;
      if (q) {
        const orderId = String(order.id || "").toLowerCase();
        const orderName = String(order.name || "").toLowerCase();
        const customerName = String(order.customerName || "").toLowerCase();
        const customerEmail = String(order.customerEmail || "").toLowerCase();
        const itemsSummary = String(order.itemsSummary || "").toLowerCase();

        matchesSearch =
          orderName.includes(q) ||
          customerName.includes(q) ||
          customerEmail.includes(q) ||
          itemsSummary.includes(q) ||
          orderId.includes(q) ||
          (qNumeric && orderId.includes(qNumeric));
      }

      // Financial status filter
      const matchesFinancial =
        financialFilter === "ALL" ||
        order.financialStatus.toUpperCase() === financialFilter.toUpperCase();

      // Date range filter
      let matchesDate = true;
      if (startDate && order.date < startDate) matchesDate = false;
      if (endDate && order.date > endDate) matchesDate = false;

      return matchesSearch && matchesFinancial && matchesDate;
    });
  }, [activeOrders, searchQuery, financialFilter, startDate, endDate]);

  // Grouped Data Aggregation (Day-wise, Weekly, Monthly)
  const groupedData = useMemo(() => {
    const groups = {};

    filteredOrders.forEach((order) => {
      let key = "";
      let label = "";

      if (grouping === "daily") {
        key = order.date || "Unknown";
        label = getDayLabel(order.date);
      } else if (grouping === "weekly") {
        const d = new Date(order.date || Date.now());
        const year = d.getFullYear() || 2026;
        const week = getIsoWeek(d);
        key = `${year}-W${week}`;
        label = getWeekRangeLabel(order.date);
      } else if (grouping === "monthly") {
        key = order.date ? order.date.substring(0, 7) : "Unknown";
        label = getMonthLabel(order.date);
      }

      if (!groups[key]) {
        groups[key] = {
          key,
          label,
          orderCount: 0,
          totalRevenue: 0,
          totalTax: 0,
          currency: order.currency || shopCurrency,
          orders: [],
        };
      }

      groups[key].orderCount += 1;
      groups[key].totalRevenue += order.totalPrice;
      groups[key].totalTax += order.totalTax;
      groups[key].orders.push(order);
    });

    // Convert object to sorted array (descending by key)
    return Object.values(groups).sort((a, b) => b.key.localeCompare(a.key));
  }, [filteredOrders, grouping, shopCurrency]);

  // Total Summary Metrics
  const summaryMetrics = useMemo(() => {
    const totalOrders = filteredOrders.length;
    const totalRevenue = filteredOrders.reduce((sum, o) => sum + o.totalPrice, 0);
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const currency = filteredOrders[0]?.currency || shopCurrency;

    return { totalOrders, totalRevenue, avgOrderValue, currency };
  }, [filteredOrders, shopCurrency]);

  // Download Excel functionality using SheetJS (XLSX)
  const exportToExcel = () => {
    // Worksheet 1: Grouped Summary Data
    const summaryRows = groupedData.map((group) => ({
      "Period Key": group.key,
      "Timeframe Period": group.label,
      "Order Count": group.orderCount,
      [`Total Revenue (${group.currency})`]: group.totalRevenue.toFixed(2),
      [`Total Tax (${group.currency})`]: group.totalTax.toFixed(2),
      [`Average Order Value (${group.currency})`]: (
        group.orderCount > 0 ? group.totalRevenue / group.orderCount : 0
      ).toFixed(2),
    }));

    // Worksheet 2: Detailed Individual Orders Data
    const detailedRows = filteredOrders.map((order) => ({
      "Order Name": order.name,
      "Date Created": new Date(order.createdAt).toLocaleString(),
      "Customer Name": order.customerName,
      "Customer Email": order.customerEmail,
      "Financial Status": order.financialStatus,
      "Fulfillment Status": order.fulfillmentStatus,
      "Items Count": order.itemCount,
      "Line Items Summary": order.itemsSummary,
      [`Total Price (${order.currency})`]: order.totalPrice.toFixed(2),
      [`Tax (${order.currency})`]: order.totalTax.toFixed(2),
    }));

    const workbook = XLSX.utils.book_new();

    const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(workbook, summaryWs, `${grouping.toUpperCase()} Summary`);

    const detailedWs = XLSX.utils.json_to_sheet(detailedRows);
    XLSX.utils.book_append_sheet(workbook, detailedWs, "Detailed Orders");

    // Save Excel file
    const fileName = `Shopify_Orders_${grouping}_Report_${new Date()
      .toISOString()
      .slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  };

  const getStatusBadgeClass = (status) => {
    const s = (status || "").toUpperCase();
    if (s === "PAID") return "badge-success";
    if (s === "PENDING" || s === "AUTHORIZED") return "badge-warning";
    if (s === "REFUNDED" || s === "VOIDED") return "badge-critical";
    return "badge-neutral";
  };

  return (
    <s-page heading="Order Details Analytics">
      {/* Top Bar Action for Excel Export */}
      <div slot="primary-action">
        <button
          onClick={exportToExcel}
          style={{
            backgroundColor: "#107c41",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            padding: "8px 16px",
            fontSize: "14px",
            fontWeight: "600",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export to Excel (.xlsx)
        </button>
      </div>

      {errorMsg && (
        <s-box padding="base" background="critical" borderRadius="base" style={{ marginBottom: "16px" }}>
          <s-paragraph style={{ color: "#7f1d1d", margin: 0 }}>
            ⚠️ <strong>Error loading live shop orders:</strong> {errorMsg}. Scopes require `read_orders`. Displaying sample demonstration orders below.
          </s-paragraph>
        </s-box>
      )}

      {realOrders.length === 0 && !errorMsg && (
        <s-box
          padding="base"
          background="subdued"
          borderRadius="base"
          style={{ marginBottom: "16px", border: "1px solid #e1e3e5" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "14px", color: "#4a4a4a" }}>
              ℹ️ Store currently has 0 live orders. Demonstration mode active with sample order data.
            </span>
            <label style={{ fontSize: "13px", fontWeight: "600", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={useSampleData}
                onChange={(e) => setUseSampleData(e.target.checked)}
                style={{ marginRight: "6px" }}
              />
              Show Sample Orders
            </label>
          </div>
        </s-box>
      )}

      {/* Overview Metric Cards */}
      <s-section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          <div className="metric-card">
            <span className="metric-label">Total Orders</span>
            <span className="metric-value">{summaryMetrics.totalOrders}</span>
            <span className="metric-subtext">Filtered count</span>
          </div>

          <div className="metric-card">
            <span className="metric-label">Total Revenue</span>
            <span className="metric-value">
              {formatCurrency(summaryMetrics.totalRevenue, summaryMetrics.currency)}
            </span>
            <span className="metric-subtext">Gross sales</span>
          </div>

          <div className="metric-card">
            <span className="metric-label">Average Order Value</span>
            <span className="metric-value">
              {formatCurrency(summaryMetrics.avgOrderValue, summaryMetrics.currency)}
            </span>
            <span className="metric-subtext">AOV per order</span>
          </div>
        </div>
      </s-section>

      {/* Filtering & Timeframe Toolbar */}
      <s-section heading="Filter & Group Data">
        <s-box padding="base" borderRadius="base" style={{ background: "#ffffff", border: "1px solid #e1e3e5", marginBottom: "20px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center", justifyContent: "space-between" }}>
            {/* Timeframe Group Selector Tabs */}
            <div style={{ display: "flex", gap: "6px", background: "#f1f2f4", padding: "4px", borderRadius: "8px" }}>
              <button
                type="button"
                className={`tab-btn ${grouping === "daily" ? "active" : ""}`}
                onClick={() => setGrouping("daily")}
              >
                📅 Day-wise
              </button>
              <button
                type="button"
                className={`tab-btn ${grouping === "weekly" ? "active" : ""}`}
                onClick={() => setGrouping("weekly")}
              >
                📊 Weekly
              </button>
              <button
                type="button"
                className={`tab-btn ${grouping === "monthly" ? "active" : ""}`}
                onClick={() => setGrouping("monthly")}
              >
                🗓️ Monthly
              </button>
            </div>

            {/* Status & Search Controls */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" }}>
              {/* Financial Status Dropdown */}
              <select
                value={financialFilter}
                onChange={(e) => setFinancialFilter(e.target.value)}
                className="filter-input"
              >
                <option value="ALL">All Payment Statuses</option>
                <option value="PAID">Paid</option>
                <option value="PENDING">Pending</option>
                <option value="REFUNDED">Refunded</option>
              </select>

              {/* Start Date */}
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="filter-input"
                title="Start Date"
              />

              {/* End Date */}
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="filter-input"
                title="End Date"
              />

              {/* Search Query */}
              <input
                type="text"
                placeholder="Search order #, customer, item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="filter-input"
                style={{ minWidth: "220px" }}
              />

              {(searchQuery || financialFilter !== "ALL" || startDate || endDate) && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setFinancialFilter("ALL");
                    setStartDate("");
                    setEndDate("");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#005bd3",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: "600",
                  }}
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>
        </s-box>
      </s-section>

      {/* Main Grouped Summary & Detail Table */}
      <s-section heading={`${grouping.charAt(0).toUpperCase() + grouping.slice(1)} Breakdown (${groupedData.length} periods)`}>
        <div style={{ background: "#ffffff", border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          {groupedData.length === 0 ? (
            <div style={{ padding: "32px", textAlign: "center", color: "#6d7175" }}>
              No order data matches the selected filters.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ background: "#f7f8f9", borderBottom: "1px solid #e1e3e5", textAlign: "left" }}>
                  <th style={{ padding: "12px 16px" }}>Period</th>
                  <th style={{ padding: "12px 16px" }}>Orders Count</th>
                  <th style={{ padding: "12px 16px" }}>Total Revenue</th>
                  <th style={{ padding: "12px 16px" }}>Tax</th>
                  <th style={{ padding: "12px 16px" }}>Avg Order Value</th>
                  <th style={{ padding: "12px 16px", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupedData.map((group) => {
                  const isExpanded = expandedGroup === group.key;
                  const avg = group.orderCount > 0 ? group.totalRevenue / group.orderCount : 0;

                  return (
                    <React.Fragment key={group.key}>
                      <tr
                        style={{
                          borderBottom: "1px solid #e1e3e5",
                          backgroundColor: isExpanded ? "#f4f6f8" : "transparent",
                          transition: "background 0.15s ease",
                        }}
                      >
                        <td style={{ padding: "12px 16px", fontWeight: "600", color: "#202223" }}>
                          {group.label}
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          <span className="badge-count">{group.orderCount} orders</span>
                        </td>
                        <td style={{ padding: "12px 16px", fontWeight: "600", color: "#107c41" }}>
                          {formatCurrency(group.totalRevenue, group.currency)}
                        </td>
                        <td style={{ padding: "12px 16px", color: "#6d7175" }}>
                          {formatCurrency(group.totalTax, group.currency)}
                        </td>
                        <td style={{ padding: "12px 16px" }}>
                          {formatCurrency(avg, group.currency)}
                        </td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>
                          <button
                            type="button"
                            onClick={() => setExpandedGroup(isExpanded ? null : group.key)}
                            style={{
                              background: isExpanded ? "#202223" : "#f1f2f4",
                              color: isExpanded ? "#ffffff" : "#202223",
                              border: "none",
                              borderRadius: "4px",
                              padding: "6px 12px",
                              fontSize: "12px",
                              fontWeight: "600",
                              cursor: "pointer",
                            }}
                          >
                            {isExpanded ? "Hide Orders ▲" : "View Orders ▼"}
                          </button>
                        </td>
                      </tr>

                      {/* Expandable Order Details Row */}
                      {isExpanded && (
                        <tr>
                          <td colSpan="6" style={{ padding: "12px 16px", background: "#fafbfc", borderBottom: "1px solid #e1e3e5" }}>
                            <div style={{ padding: "8px 0" }}>
                              <h4 style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#202223" }}>
                                Orders in {group.label}:
                              </h4>
                              <table style={{ width: "100%", borderCollapse: "collapse", background: "#ffffff", borderRadius: "6px", border: "1px solid #e1e3e5", fontSize: "13px" }}>
                                <thead>
                                  <tr style={{ background: "#f1f2f4", textAlign: "left" }}>
                                    <th style={{ padding: "8px 12px" }}>Order</th>
                                    <th style={{ padding: "8px 12px" }}>Date</th>
                                    <th style={{ padding: "8px 12px" }}>Customer</th>
                                    <th style={{ padding: "8px 12px" }}>Items</th>
                                    <th style={{ padding: "8px 12px" }}>Status</th>
                                    <th style={{ padding: "8px 12px", textAlign: "right" }}>Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {group.orders.map((order) => (
                                    <tr key={order.id} style={{ borderBottom: "1px solid #f1f2f4" }}>
                                      <td style={{ padding: "8px 12px", fontWeight: "600" }}>{order.name}</td>
                                      <td style={{ padding: "8px 12px", color: "#6d7175" }}>
                                        {new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                      </td>
                                      <td style={{ padding: "8px 12px" }}>
                                        <div>{order.customerName}</div>
                                        <div style={{ fontSize: "11px", color: "#6d7175" }}>{order.customerEmail}</div>
                                      </td>
                                      <td style={{ padding: "8px 12px", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {order.itemsSummary}
                                      </td>
                                      <td style={{ padding: "8px 12px" }}>
                                        <span className={`status-badge ${getStatusBadgeClass(order.financialStatus)}`}>
                                          {order.financialStatus}
                                        </span>
                                      </td>
                                      <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: "600" }}>
                                        {formatCurrency(order.totalPrice, order.currency)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </s-section>

      {/* Embedded Custom CSS Styles */}
      <style>{`
        .metric-card {
          background: #ffffff;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        }
        .metric-label {
          font-size: 13px;
          color: #6d7175;
          font-weight: 500;
        }
        .metric-value {
          font-size: 24px;
          font-weight: 700;
          color: #202223;
          margin: 4px 0;
        }
        .metric-subtext {
          font-size: 12px;
          color: #8c9196;
        }
        .tab-btn {
          border: none;
          background: transparent;
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          color: #5c5f62;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .tab-btn.active {
          background: #ffffff;
          color: #202223;
          box-shadow: 0 1px 3px rgba(0,0,0,0.12);
        }
        .filter-input {
          padding: 6px 10px;
          border: 1px solid #c9cccf;
          border-radius: 6px;
          font-size: 13px;
          color: #202223;
          outline: none;
          background: #ffffff;
        }
        .filter-input:focus {
          border-color: #005bd3;
          box-shadow: 0 0 0 1px #005bd3;
        }
        .badge-count {
          background: #e4e5e7;
          color: #202223;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }
        .status-badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
        }
        .badge-success {
          background: #e3f1df;
          color: #0d5e27;
        }
        .badge-warning {
          background: #fff4e5;
          color: #9c5b00;
        }
        .badge-critical {
          background: #fbeae8;
          color: #a80000;
        }
        .badge-neutral {
          background: #e4e5e7;
          color: #4a4a4a;
        }
      `}</style>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error();
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
