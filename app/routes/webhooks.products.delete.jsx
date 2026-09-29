import { createAuthenticatedStoreAnalytics } from "../store-analytics-access.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const productId = String(payload?.id || "").replace(/\D/g, "");
  if (!productId) return new Response("Missing product ID", { status: 400 });

  const analytics = await createAuthenticatedStoreAnalytics({ shop });
  if (analytics) await analytics.markProductDeleted(productId);
  return new Response();
};
