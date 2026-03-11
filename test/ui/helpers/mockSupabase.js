function compareValues(a, b, ascending = true, nullsFirst = false) {
  const direction = ascending === false ? -1 : 1;
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;

  if (aNull && bNull) return 0;
  if (aNull) return nullsFirst ? -1 : 1;
  if (bNull) return nullsFirst ? 1 : -1;
  if (a === b) return 0;
  return a > b ? direction : -direction;
}

function applyQuery(tableRows, state) {
  let rows = [...(tableRows || [])];

  for (const filter of state.filters) {
    if (filter.type === "eq") {
      rows = rows.filter((row) => row?.[filter.column] === filter.value);
    }
    if (filter.type === "in") {
      const allowed = new Set(filter.values || []);
      rows = rows.filter((row) => allowed.has(row?.[filter.column]));
    }
  }

  for (const order of state.orders) {
    rows.sort((left, right) => compareValues(
      left?.[order.column],
      right?.[order.column],
      order.ascending,
      order.nullsFirst
    ));
  }

  if (state.limit !== null) rows = rows.slice(0, state.limit);
  return rows;
}

function finalizeQuery(rows, mode) {
  if (mode === "maybeSingle") {
    return { data: rows[0] ?? null, error: null };
  }

  if (mode === "single") {
    if (!rows.length) {
      return { data: null, error: new Error("No rows returned.") };
    }
    return { data: rows[0], error: null };
  }

  return { data: rows, error: null };
}

function buildQueryBuilder(tables, tableName) {
  const state = {
    filters: [],
    orders: [],
    limit: null,
    mode: "list",
  };

  const execute = () => finalizeQuery(applyQuery(tables[tableName], state), state.mode);

  const builder = {
    select() {
      return builder;
    },
    eq(column, value) {
      state.filters.push({ type: "eq", column, value });
      return builder;
    },
    in(column, values) {
      state.filters.push({ type: "in", column, values });
      return builder;
    },
    order(column, options = {}) {
      state.orders.push({
        column,
        ascending: options.ascending,
        nullsFirst: options.nullsFirst,
      });
      return builder;
    },
    limit(value) {
      state.limit = value;
      return builder;
    },
    maybeSingle() {
      state.mode = "maybeSingle";
      return Promise.resolve(execute());
    },
    single() {
      state.mode = "single";
      return Promise.resolve(execute());
    },
    then(resolve, reject) {
      return Promise.resolve(execute()).then(resolve, reject);
    },
  };

  return builder;
}

export function createSupabaseMock(tables) {
  return {
    from(tableName) {
      return buildQueryBuilder(tables, tableName);
    },
    channel(name) {
      const channel = {
        name,
        on() {
          return channel;
        },
        subscribe() {
          return channel;
        },
      };
      return channel;
    },
    removeChannel() {},
  };
}
