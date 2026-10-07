import { useEffect, useState } from "react";
import {
  Outlet,
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { createAuthenticatedStoreAnalytics } from "../store-analytics-access.server.js";
import { isSupabaseAnalyticsConfigured } from "../supabase-analytics.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const storageConfigured = isSupabaseAnalyticsConfigured();
  let storageAssigned = false;
  let storageMode = null;
  if (storageConfigured) {
    try {
      const analytics = await createAuthenticatedStoreAnalytics(session);
      storageAssigned = Boolean(analytics);
      storageMode = analytics?.store.storage_mode || null;
    } catch (error) {
      console.error("Could not check analytics storage assignment:", error.message);
    }
  }

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    storageConfigured,
    storageAssigned,
    storageMode,
  };
};

export default function App() {
  const { apiKey, storageConfigured, storageAssigned, storageMode } = useLoaderData();
  const storageAssignment = useFetcher();
  const [analyticsBootstrap, setAnalyticsBootstrap] = useState(null);
  const effectiveStorageMode =
    storageMode || storageAssignment.data?.storageMode || null;

  useEffect(() => {
    if (
      storageConfigured &&
      !storageAssigned &&
      storageAssignment.state === "idle" &&
      storageAssignment.data === undefined
    ) {
      storageAssignment.submit(null, {
        method: "POST",
        action: "/app/analytics-storage",
      });
    }
  }, [storageAssigned, storageConfigured, storageAssignment]);

  useEffect(() => {
    if (!effectiveStorageMode) return undefined;
    let active = true;
    import("../analytics-bootstrap.client.js")
      .then(({ bootstrapAnalyticsData }) =>
        bootstrapAnalyticsData({
          storageMode: effectiveStorageMode,
          onStatus: (status) => {
            if (active) setAnalyticsBootstrap(status);
          },
        }),
      )
      .catch((error) => {
        console.warn("Could not prepare the analytics cache:", error.message);
        if (active) {
          const reason = /401|unauthor|session/i.test(error.message)
            ? "The Shopify session needs to be renewed."
            : /rate limit|throttl/i.test(error.message)
              ? "Shopify temporarily limited analytics requests."
              : /timeout|taking longer/i.test(error.message)
                ? "The monthly step took longer than expected."
                : "One monthly preparation step failed.";
          setAnalyticsBootstrap({
            state: "error",
            message: `${reason} Saved analytics will resume the next time the app opens.`,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [effectiveStorageMode]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/products">Product audit</s-link>
        <s-link href="/app/new-arrivals">New arrival analysis</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-app-nav>
      {analyticsBootstrap && analyticsBootstrap.state !== "ready" && (
        <div
          role="status"
          aria-live="polite"
          style={{
            margin: "10px 16px 0",
            padding: "10px 12px",
            border: "1px solid #b7c9e2",
            borderRadius: "8px",
            background: analyticsBootstrap.state === "error" ? "#fff4e5" : "#f1f7ff",
            color: "#303030",
            fontSize: "13px",
          }}
        >
          {analyticsBootstrap.message}
        </div>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
