/**
 * A very small Horizon read client for the demo's history and destination
 * checks.
 *
 * Horizon is the one network dependency this page has, and its responses are
 * endpoint-controlled input, so the rules the snap applies to the same data
 * apply here too: a bounded timeout on every request, a cap on the size of
 * the body it will read, redirects refused so a 307 cannot replay the query
 * somewhere else, and every consumed field type-checked before it reaches
 * the UI rather than spread into it. React
 * escapes text, so this is not about script injection; it is about a missing
 * or wrong-typed field rendering as `undefined` in a row that a user reads as
 * a record of their own money.
 *
 * The base URL always comes from the snap (`getNetworkDetails().networkUrl`),
 * never from this page, so the demo cannot read from a network the wallet is
 * not on. `static/_headers` allowlists exactly the three Horizon hosts the
 * snap can name.
 */

/** Bound every request so a slow endpoint cannot hang the page. */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Upper bound on a Horizon response body. The body is endpoint-controlled
 * input, and a page that buffers whatever it is sent can be made to allocate
 * without limit; the only cost is this tab, but it is cheap to refuse. The
 * largest legitimate response here (twenty operation records with their
 * transactions joined) stays well under 100 KiB, so 1 MiB is generous. The
 * snap applies the same bound to its own reads of the same hosts.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Rows requested from Horizon, and the most the table will render. */
export const HISTORY_LIMIT = 20;

/** Cap on any single endpoint-controlled string reaching the DOM. */
const MAX_FIELD_LENGTH = 128;

/**
 * Reads a string field, bounded.
 *
 * @param source - The record to read from.
 * @param key - The field name.
 * @returns The string, or null when absent or not a string.
 */
function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : null;
}

/**
 * Abandons a response body that will not be read, so the browser can release
 * the connection and stream resources instead of keeping them alive until
 * garbage collection. Best effort: a body that is locked or already consumed
 * has nothing to release.
 *
 * @param response - The fetch response whose body is being discarded.
 */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/**
 * Reads a response body as text without letting it exceed the byte cap.
 *
 * The declared `Content-Length` is checked first, then the body is consumed
 * incrementally and abandoned the moment the running total passes the cap,
 * so a server that omits or understates the header cannot have the whole
 * body buffered before the cap is applied. When the runtime exposes no body
 * stream the buffered fallback still refuses to hand oversized data onward,
 * which is the most it can do.
 *
 * @param response - The fetch response.
 * @returns The body text, or null when it exceeds the cap.
 */
async function readTextBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > MAX_RESPONSE_BYTES
      ? null
      : new TextDecoder().decode(bytes);
  }

  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Performs a bounded GET and parses JSON.
 *
 * Bounded in time (the abort timer spans the body read, not only the
 * headers) and in size (see `readTextBounded`); either bound being exceeded
 * reads as a failed request.
 *
 * @param url - The absolute URL.
 * @returns The parsed body, or null on any failure (including 404).
 */
async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      discardBody(response);
      return null;
    }
    const text = await readTextBounded(response);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether an account exists on the ledger.
 *
 * The distinction matters before a payment is built: a `payment` operation to
 * an account that does not exist fails, and the operation that funds it is
 * `createAccount`. Returning null for "could not tell" keeps that separate
 * from a definite "does not exist", so the caller never silently picks the
 * wrong operation on a network hiccup.
 *
 * @param horizonUrl - The active network's Horizon base URL.
 * @param address - The `G...` account to check.
 * @returns True, false, or null when the lookup itself failed.
 */
export async function accountExists(
  horizonUrl: string,
  address: string,
): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${horizonUrl.replace(/\/$/u, '')}/accounts/${encodeURIComponent(address)}`,
      {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    // Only the status is consumed on any of these paths, so the body is
    // released on all of them.
    discardBody(response);
    if (response.status === 404) {
      return false;
    }
    return response.ok ? true : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Which way an operation moved value for the account being viewed. */
export type Direction = 'in' | 'out' | 'neutral';

/** A normalized history row. */
export type HistoryEntry = {
  id: string;
  /** Horizon's operation type, e.g. `payment`. */
  type: string;
  /** Human-readable operation label. */
  label: string;
  createdAt: string;
  hash: string | null;
  successful: boolean;
  /** Signed-free amount with its asset, when the operation carries one. */
  amount: string | null;
  asset: string | null;
  /** The other party, when the operation has one. */
  counterparty: string | null;
  direction: Direction;
};

/** Operation labels, for the types this demo can produce or receive. */
const LABELS: Record<string, string> = {
  /* eslint-disable @typescript-eslint/naming-convention */
  payment: 'Payment',
  create_account: 'Create account',
  change_trust: 'Trustline',
  account_merge: 'Account merge',
  path_payment_strict_send: 'Path payment',
  path_payment_strict_receive: 'Path payment',
  invoke_host_function: 'Contract call',
  extend_footprint_ttl: 'Extend TTL',
  restore_footprint: 'Restore footprint',
  manage_data: 'Manage data',
  set_options: 'Set options',
  /* eslint-enable @typescript-eslint/naming-convention */
};

/**
 * Names the asset a Horizon operation record refers to.
 *
 * @param record - The operation record.
 * @param prefix - Field prefix (`asset` or `source_asset`).
 * @returns The asset code, or null when the record names none.
 */
function recordAsset(
  record: Record<string, unknown>,
  prefix = 'asset',
): string | null {
  const type = str(record, `${prefix}_type`);
  if (type === 'native') {
    return 'XLM';
  }
  return str(record, `${prefix}_code`);
}

/**
 * Normalizes one Horizon operation record into a display row.
 *
 * @param record - The raw record.
 * @param address - The account whose history is being shown.
 * @returns The row, or null when the record is unusable.
 */
function toEntry(
  record: Record<string, unknown>,
  address: string,
): HistoryEntry | null {
  const id = str(record, 'id');
  const type = str(record, 'type');
  const createdAt = str(record, 'created_at');
  if (!id || !type || !createdAt) {
    return null;
  }

  const entry: HistoryEntry = {
    id,
    type,
    label: LABELS[type] ?? type.replace(/_/gu, ' '),
    createdAt,
    // Kept as reported (bounded, like every other field) so the row can show
    // it as text; whether it is a well-formed hash is decided where it would
    // become a link (`explorerTxUrl`), which refuses anything that is not 64
    // hex characters rather than interpolating it into an explorer URL.
    hash: str(record, 'transaction_hash'),
    // Absent means successful on the default (non-failed) feed; only an
    // explicit `false` marks a failure.
    successful: record.transaction_successful !== false,
    amount: null,
    asset: null,
    counterparty: null,
    direction: 'neutral',
  };

  switch (type) {
    case 'payment': {
      const from = str(record, 'from');
      const to = str(record, 'to');
      entry.amount = str(record, 'amount');
      entry.asset = recordAsset(record);
      entry.direction = to === address ? 'in' : 'out';
      entry.counterparty = to === address ? from : to;
      break;
    }
    case 'create_account': {
      const funder = str(record, 'funder');
      const account = str(record, 'account');
      entry.amount = str(record, 'starting_balance');
      entry.asset = 'XLM';
      entry.direction = account === address ? 'in' : 'out';
      entry.counterparty = account === address ? funder : account;
      break;
    }
    case 'path_payment_strict_send':
    case 'path_payment_strict_receive': {
      const from = str(record, 'from');
      const to = str(record, 'to');
      const incoming = to === address;
      entry.amount = incoming
        ? str(record, 'amount')
        : (str(record, 'source_amount') ?? str(record, 'amount'));
      entry.asset = incoming
        ? recordAsset(record)
        : (recordAsset(record, 'source_asset') ?? recordAsset(record));
      entry.direction = incoming ? 'in' : 'out';
      entry.counterparty = incoming ? from : to;
      break;
    }
    case 'change_trust': {
      entry.asset = recordAsset(record);
      entry.counterparty = str(record, 'trustee') ?? str(record, 'trustor');
      // A zero limit is a removal, which is worth distinguishing at a glance.
      entry.label =
        str(record, 'limit') === '0.0000000'
          ? 'Trustline removed'
          : 'Trustline set';
      break;
    }
    case 'account_merge': {
      entry.counterparty = str(record, 'into');
      break;
    }
    case 'invoke_host_function': {
      entry.counterparty = str(record, 'address');
      break;
    }
    default:
      break;
  }

  return entry;
}

/**
 * Reads the account's most recent operations.
 *
 * Failed transactions are included: a payment that bounced is part of the
 * account's history, and omitting it would leave a user who just watched one
 * fail with an unexplained gap.
 *
 * @param horizonUrl - The active network's Horizon base URL.
 * @param address - The `G...` account.
 * @returns The rows, newest first. Empty on any failure.
 */
export async function fetchHistory(
  horizonUrl: string,
  address: string,
): Promise<HistoryEntry[]> {
  const url =
    `${horizonUrl.replace(/\/$/u, '')}/accounts/${encodeURIComponent(address)}` +
    `/operations?order=desc&limit=${HISTORY_LIMIT}&include_failed=true&join=transactions`;
  const body = await getJson(url);
  const records = (body as { _embedded?: { records?: unknown } } | null)
    ?._embedded?.records;
  if (!Array.isArray(records)) {
    return [];
  }
  return records
    .slice(0, HISTORY_LIMIT)
    .filter(
      (record): record is Record<string, unknown> =>
        typeof record === 'object' && record !== null,
    )
    .map((record) => toEntry(record, address))
    .filter((entry): entry is HistoryEntry => entry !== null);
}
