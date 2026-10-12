import { authenticate, sessionStorage } from "../shopify.server";
import { markSupabaseStoreUninstalled } from "../supabase-analytics.server.js";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can repeat after the session has already been removed.
  const sessions = await sessionStorage.findSessionsByShop(shop);
  const sessionIds = new Set(sessions.map((stored) => stored.id));
  if (session?.id) sessionIds.add(session.id);
  if (sessionIds.size) {
    await sessionStorage.deleteSessions([...sessionIds]);
  }
  await markSupabaseStoreUninstalled(shop);

  return new Response();
};
