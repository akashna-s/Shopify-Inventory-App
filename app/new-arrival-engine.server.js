function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanProductId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function monthLabel(month) {
  if (!month) return "—";
  const date = new Date(`${month}-01T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", "-");
}

function buildRecords(sourceRows) {
  return sourceRows
    .map((row) => ({
      pid: cleanProductId(row.productId),
      month: String(row.month || "").slice(0, 7),
      type: String(row.productType || "").trim() || "Others",
      title: String(row.title || "").trim(),
      startRaw: number(row.startingInventory),
      start: Math.max(0, number(row.startingInventory)),
      end: Math.max(0, number(row.endingInventory)),
      sales: Math.max(0, number(row.totalSales)),
    }))
    .filter((row) => row.pid && /^\d{4}-\d{2}$/.test(row.month))
    .map((row) => ({ ...row, active: row.startRaw > 0 || row.end > 0 || row.sales > 0 }));
}

function aggregateProductMonths(records) {
  const groups = new Map();
  for (const row of records) {
    const key = `${row.pid}|${row.month}`;
    const current = groups.get(key) || {
      pid: row.pid,
      month: row.month,
      start: 0,
      end: 0,
      sales: 0,
      active: false,
    };
    current.start += row.start;
    current.end += row.end;
    current.sales += row.sales;
    current.active ||= row.active;
    groups.set(key, current);
  }
  return [...groups.values()];
}

function buildProductMaps(records, aggregated) {
  const launch = new Map();
  const titles = new Map();
  const types = new Map();
  const lookup = new Map();

  for (const row of records) {
    if (row.title && !titles.has(row.pid)) titles.set(row.pid, row.title);
    if (!types.has(row.pid)) types.set(row.pid, new Set());
    types.get(row.pid).add(row.type);
  }
  for (const row of aggregated) {
    if (!lookup.has(row.pid)) lookup.set(row.pid, new Map());
    lookup.get(row.pid).set(row.month, row);
    if (row.active && (!launch.has(row.pid) || row.month < launch.get(row.pid))) launch.set(row.pid, row.month);
  }
  return {
    launch,
    titles,
    types: new Map([...types].map(([pid, values]) => [pid, [...values].sort()])),
    lookup,
  };
}

function brandDenominators(productMaps, months) {
  const inventory = Object.fromEntries(months.map((month) => [month, 0]));
  const activeSkus = Object.fromEntries(months.map((month) => [month, 0]));
  for (const [pid, monthRows] of productMaps.lookup) {
    const launchMonth = productMaps.launch.get(pid);
    for (const month of months) {
      const row = monthRows.get(month);
      if (!row) continue;
      if (launchMonth && month === launchMonth) inventory[month] += row.end;
      else if (launchMonth && month > launchMonth) inventory[month] += row.start;
      if (row.active) activeSkus[month] += 1;
    }
  }
  return { inventory, activeSkus };
}

function calculateMatrix(pids, months, productMaps, monthlyStoreSales, denominators) {
  const allowed = new Set(pids.filter((pid) => productMaps.launch.has(pid)));
  const launchCounts = Object.fromEntries(months.map((month) => [month, 0]));
  const cube = Object.fromEntries(months.map((cohort) => [
    cohort,
    Object.fromEntries(months.map((month) => [month, { active: 0, inventory: 0, sales: 0 }])),
  ]));

  for (const pid of allowed) {
    const cohort = productMaps.launch.get(pid);
    if (!(cohort in launchCounts)) continue;
    launchCounts[cohort] += 1;
    const monthRows = productMaps.lookup.get(pid) || new Map();
    for (const month of months) {
      if (month < cohort) continue;
      const row = monthRows.get(month);
      if (!row?.active) continue;
      cube[cohort][month].active += 1;
      cube[cohort][month].sales += row.sales;
      cube[cohort][month].inventory += month === cohort ? row.end : row.start;
    }
  }

  const grandRaw = Object.fromEntries(months.map((month) => [month, { active: 0, inventory: 0, sales: 0 }]));
  const rows = months.map((cohort) => {
    const launched = launchCounts[cohort];
    const values = {};
    for (const month of months) {
      if (month < cohort) {
        values[month] = null;
        continue;
      }
      const raw = cube[cohort][month];
      grandRaw[month].active += raw.active;
      grandRaw[month].inventory += raw.inventory;
      grandRaw[month].sales += raw.sales;
      values[month] = {
        naSkus: raw.active,
        naSkuRate: launched ? raw.active / launched : 0,
        naSkuTotalRate: denominators.activeSkus[month] ? raw.active / denominators.activeSkus[month] : 0,
        naInventory: raw.inventory,
        naInventoryRate: denominators.inventory[month] ? raw.inventory / denominators.inventory[month] : 0,
        naSales: raw.sales,
        naSalesRate: monthlyStoreSales[month] ? raw.sales / monthlyStoreSales[month] : 0,
      };
    }
    return { cohort, label: `${monthLabel(cohort)} NA`, values };
  });

  let cumulativeLaunched = 0;
  const grand = {};
  for (const month of months) {
    cumulativeLaunched += launchCounts[month];
    const raw = grandRaw[month];
    grand[month] = {
      naSkus: raw.active,
      naSkuRate: cumulativeLaunched ? raw.active / cumulativeLaunched : 0,
      naSkuTotalRate: denominators.activeSkus[month] ? raw.active / denominators.activeSkus[month] : 0,
      naInventory: raw.inventory,
      naInventoryRate: denominators.inventory[month] ? raw.inventory / denominators.inventory[month] : 0,
      naSales: raw.sales,
      naSalesRate: monthlyStoreSales[month] ? raw.sales / monthlyStoreSales[month] : 0,
    };
  }
  return { rows, grand, launchCounts };
}

export function generateNewArrivalReport(sourceRows, months, monthlyStoreSales) {
  const records = buildRecords(sourceRows);
  const aggregated = aggregateProductMonths(records);
  const productMaps = buildProductMaps(records, aggregated);
  const denominators = brandDenominators(productMaps, months);
  const allPids = [...productMaps.lookup.keys()];
  const overall = calculateMatrix(allPids, months, productMaps, monthlyStoreSales, denominators);

  const lastMonth = months.at(-1);
  const typeSales = new Map();
  for (const [pid, types] of productMaps.types) {
    const sales = productMaps.lookup.get(pid)?.get(lastMonth)?.sales || 0;
    for (const type of types) typeSales.set(type, (typeSales.get(type) || 0) + sales);
  }
  const productTypes = [...typeSales.keys()].sort((a, b) => (typeSales.get(b) || 0) - (typeSales.get(a) || 0));
  const byProductType = productTypes.map((type) => ({
    type,
    matrix: calculateMatrix(
      [...productMaps.types].filter(([, types]) => types.includes(type)).map(([pid]) => pid),
      months,
      productMaps,
      monthlyStoreSales,
      denominators,
    ),
  }));

  const typeTotals = new Map();
  for (const [pid, types] of productMaps.types) {
    for (const month of months) {
      const sales = productMaps.lookup.get(pid)?.get(month)?.sales || 0;
      for (const type of types) typeTotals.set(`${type}|${month}`, (typeTotals.get(`${type}|${month}`) || 0) + sales);
    }
  }
  const details = [];
  for (const [pid, cohort] of productMaps.launch) {
    for (const type of productMaps.types.get(pid) || ["Others"]) {
      const values = {};
      for (const month of months) {
        if (month < cohort) {
          values[month] = null;
          continue;
        }
        const row = productMaps.lookup.get(pid)?.get(month);
        const sales = row?.sales || 0;
        const typeTotal = typeTotals.get(`${type}|${month}`) || 0;
        values[month] = {
          startingInventory: row?.start || 0,
          endingInventory: row?.end || 0,
          sales,
          typeSalesRate: typeTotal ? sales / typeTotal : 0,
          totalSalesRate: monthlyStoreSales[month] ? sales / monthlyStoreSales[month] : 0,
        };
      }
      details.push({ cohort, title: productMaps.titles.get(pid) || "", productId: pid, productType: type, values });
    }
  }
  details.sort((a, b) => a.cohort.localeCompare(b.cohort) || a.productType.localeCompare(b.productType) || a.title.localeCompare(b.title) || a.productId.localeCompare(b.productId));

  return { months, overall, byProductType, details, productCount: allPids.length };
}

export { monthLabel };
