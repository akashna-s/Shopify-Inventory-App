function textValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function describeDailyRefreshError(error) {
  const responseStatus = error instanceof Response ? error.status : null;
  const objectStatus = Number(error?.status || error?.response?.status || error?.response?.code);
  const status = responseStatus || (Number.isFinite(objectStatus) ? objectStatus : null);
  const statusText = error instanceof Response
    ? textValue(error.statusText)
    : textValue(error?.statusText || error?.response?.statusText);
  const code = textValue(error?.code || error?.name);

  let message = "";
  if (error instanceof Response) {
    message = `HTTP ${error.status}${statusText ? ` ${statusText}` : ""}`;
  } else if (error instanceof Error) {
    message = textValue(error.message);
  } else if (typeof error === "string") {
    message = textValue(error);
  } else {
    message = textValue(error?.message || error?.error);
  }

  return {
    message: message || "Unknown analytics refresh failure.",
    status,
    code: code || null,
  };
}

export function dailyRefreshFailure(store, phase, error) {
  const details = describeDailyRefreshError(error);
  const messageLower = details.message.toLowerCase();
  const authenticationFailure = phase === "authentication";
  return {
    storeId: store?.id == null ? null : String(store.id),
    shopDomain: textValue(store?.shop_domain) || null,
    month: textValue(store?.month) || null,
    phase,
    error: details.message,
    status: details.status,
    code: details.code,
    authenticationFailure,
    reauthorizationRequired: authenticationFailure && (
      details.status === 401 ||
      details.status === 403 ||
      /invalid[_ -]?(subject[_ -]?)?token|missing.*session|session.*not found/.test(messageLower)
    ),
  };
}

export async function refreshFirstDueAnalyticsStore({
  dueStores,
  now,
  skippedStoreIds = [],
  authenticateStore,
  syncStore,
  logFailure = (failure) => {
    console.error(`[analytics-daily-refresh] ${JSON.stringify(failure)}`);
  },
}) {
  const skipped = new Set(skippedStoreIds.map(String));
  const candidates = dueStores.filter((store) => !skipped.has(String(store.id)));
  const failures = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const store = candidates[index];
    let phase = "authentication";
    try {
      const authentication = await authenticateStore(store);
      phase = "sync";
      const result = await syncStore(store, authentication, now);
      return {
        processed: true,
        status: result.status,
        storeId: String(store.id),
        shopDomain: store.shop_domain,
        month: store.month,
        storageMode: result.storageMode,
        remainingDue: Math.max(0, candidates.length - index - 1),
        failures,
      };
    } catch (error) {
      const failure = dailyRefreshFailure(store, phase, error);
      failures.push(failure);
      logFailure(failure);
    }
  }

  return {
    processed: false,
    remainingDue: 0,
    failures,
  };
}
