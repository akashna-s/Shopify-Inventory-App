import { createAuthenticatedStoreAnalytics } from "../store-analytics-access.server";
import { authenticate } from "../shopify.server";
import { shopifyIdText } from "../shopify-id.js";

export const action = async ({ request }) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Prefer the GraphQL ID because webhook JSON numeric IDs could eventually
  // exceed JavaScript's safe integer range before they are stringified.
  const productId = shopifyIdText(payload?.admin_graphql_api_id || payload?.id);
  if (!productId) return new Response("Missing product ID", { status: 400 });

  const analytics = await createAuthenticatedStoreAnalytics({ shop });
  if (analytics) await analytics.markProductDeleted(productId);
  return new Response();
};
