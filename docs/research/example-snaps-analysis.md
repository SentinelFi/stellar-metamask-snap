# Example Non-EVM MetaMask Snaps — Code Analysis

> Research snapshot: 2026-08-08. Sources: GitHub repos + snaps.metamask.io listings.
> Purpose: extract proven patterns (and pitfalls) for building a Stellar/Soroban snap.

Snaps analyzed:

| Snap                    | Repo                                                              | npm                              | Installs | Audit                                |
| ----------------------- | ----------------------------------------------------------------- | -------------------------------- | -------- | ------------------------------------ |
| XRPL (Peersyst)         | [Peersyst/xrpl-snap](https://github.com/Peersyst/xrpl-snap)       | `xrpl-snap`                      | ~56K     | none disclosed                       |
| Sui (Kuna Labs)         | [kunalabs-io/sui-snap](https://github.com/kunalabs-io/sui-snap)   | `@kunalabs-io/sui-metamask-snap` | ~62K     | none disclosed                       |
| NEAR (HERE Wallet)      | [here-wallet/near-snap](https://github.com/here-wallet/near-snap) | `@near-snap/plugin`              | ~32K     | OtterSec (PDF in repo)               |
| **Stellar (paulfears)** | [paulfears/StellarSnap](https://github.com/paulfears/StellarSnap) | `stellar-snap`                   | **<1K**  | Cure53 + MetaMask internal + Snapper |

---

## 1. XRPL Snap (Peersyst)

### Structure & tooling

- Yarn monorepo: `packages/snap` + `packages/site` (full React wallet dapp, CRACO/Jest/Docker). No connector package — dapps call `wallet_invokeSnap` directly.
- Site has layered architecture docs (`packages/site/docs/Architecture.md`): UI / Domain / Data-Access / Data, Zustand, controller classes, repository pattern.
- Snap deps: `xrpl ^4.0.0`, `ripple-keypairs`, `@metamask/snaps-sdk ^6.1.1`, `@metamask/key-tree ^9.1.1`. Built with `mm-snap build`. License MIT-0.

### Manifest permissions (v1.0.3)

```json
"initialPermissions": {
  "snap_dialog": {},
  "snap_manageState": {},
  "snap_getBip44Entropy": [{ "coinType": 144 }],
  "endowment:network-access": {},
  "endowment:rpc": { "dapps": true, "snaps": true }
}
```

BIP-44 entropy = **secp256k1** (XRPL supports it natively, so ed25519 avoided entirely).

### Key derivation (`packages/snap/src/core/Wallet.ts`)

- `snap_getBip44Entropy` coinType 144 → `getBIP44AddressKeyDeriver()` from `@metamask/key-tree` → path `m/44'/144'/0'/0/{index}`.
- Converts BIP-44 keys to XRPL format via helpers, `deriveAddress()` from `ripple-keypairs`.
- Tx signing delegates to `xrpl` lib Wallet `sign()` → `{ tx_blob, hash }`.

### RPC surface (handler-factory pattern)

```typescript
export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) => {
  const handlers = HandlerFactory(await Context.init());
  if (!handlers.hasOwnProperty(request.method)) throw new MethodNotSupportedError(...);
  return handlers[request.method].handle(origin, request.params);
};
```

- **Account**: `xrpl_getAccount` (silent — no dialog/origin check!), `xrpl_extractPrivateKey` (double-confirm dialog, then displays key).
- **Transaction**: `xrpl_sign`, `xrpl_submit`, `xrpl_signAndSubmit` (chains the two), `xrpl_signMessage`.
- **Network**: `xrpl_changeNetwork`, `xrpl_getActiveNetwork`, `xrpl_getStoredNetworks`, plus a generic read-proxy `RequestHandler`.

Sign flow: autofill → `validate()` (xrpl lib) → `TransactionDialog.prompt(origin, tx)` → reject ⇒ `UserRejectedRequestError` → sign.

### Dialogs

- **Strategy pattern per XRPL TransactionType** (`TransactionDialogStrategyFactory`): type-specific `buildBody`, header + origin, divider sections, raw-tx review footer, full i18n. Unsupported tx types throw — a _whitelist_ of what can be signed.

### State & network

- `snap_manageState` (default = encrypted): `{ networks[], activeNetwork }` with defaults Mainnet/Testnet/Devnet.
- Snap calls XRPL JSON-RPC nodes itself via `fetch` (`endowment:network-access`): autofill sets sequence, fee (1.2× cushion), LastLedgerSequence; broadcast happens in-snap.

### Notable

- `endowment:rpc.snaps: true` — other snaps can call it.
- `xrpl_extractPrivateKey` = deliberate portability feature but big attack surface.
- Silent `xrpl_getAccount` allows address fingerprinting once installed.

---

## 2. Sui Snap (Kuna Labs) — best-in-class UX reference

### Structure & tooling

- pnpm monorepo: `packages/snap`, `packages/wallet-adapter` (npm `@kunalabs-io/sui-snap-wallet`), `packages/wallet-dapp` (Vite+React, suisnap.com).
- The snap itself is tiny: **`src/index.tsx` + `src/util.ts`**. Deps: `@mysten/sui ^2.17.0`, `@metamask/snaps-sdk 11.1.0`, `@metamask/key-tree ^10.1.1`.

### Manifest permissions (v2.0.0, platformVersion 11.1.0)

```json
"initialPermissions": {
  "snap_dialog": {},
  "endowment:rpc": { "dapps": true, "snaps": false },
  "endowment:network-access": {},
  "snap_getBip32Entropy": [{ "path": ["m", "44'", "784'"], "curve": "ed25519" }],
  "snap_manageState": {}
}
```

### Key derivation (verbatim)

```typescript
async function deriveKeypair() {
  const res = await snap.request({
    method: 'snap_getBip32Entropy',
    params: { path: ['m', "44'", "784'"], curve: 'ed25519' },
  });
  let node = await SLIP10Node.fromJSON(res);
  node = await node.derive(["slip10:0'", "slip10:0'", "slip10:0'"]); // → m/44'/784'/0'/0'/0'
  if (!node.privateKeyBytes) throw new Error('No private key found.');
  return Ed25519Keypair.fromSecretKey(node.privateKeyBytes);
}
```

Standard Sui path ⇒ **same address as native Sui Wallet for the same mnemonic**. Single account only.

### RPC surface

- `getAccounts` — silent; returns address, base64 pubkey, `chains: ['sui:mainnet',...]`, `features: ['sui:signAndExecuteTransaction', ...]` (wallet-standard shaped).
- `signPersonalMessage` — dialog shows UTF-8 if printable else base64.
- `signTransaction` — **dry-run first**, then dialog; returns signature + bytes (dapp broadcasts).
- `signAndExecuteTransaction` — same + executes in-snap, returns effects.
- `admin_getStoredState` / `admin_setFullnodeUrl` — gated to the official wallet-dapp origin only.

### Confirmation UX — the standout design

`buildTransaction()` **simulates every tx in-snap before the dialog**, so the dialog shows: network, **estimated gas** (`computationCost + storageCost − storageRebate`), **balance changes with coin metadata/decimals**, operation list. Dry-run failure ⇒ error dialog instead of blind signing.

Hard-block screen: transactions calling `0x2::address_alias` (account-takeover primitive) are refused with a warning dialog.

### State & adapter

- State = fullnode URLs only; keys always re-derived, never stored.
- `wallet-adapter`: EIP-6963 detection with **exact rdns match** (`io.metamask`, `io.metamask.flask`, `io.metamask.mmi` — `includes()` would match spoofers), `wallet_getSnaps` probe, then implements the full **Sui wallet-standard** interface and registers via `registerSuiSnapWallet()`. Any dapp-kit dapp sees it as a normal wallet.

---

## 3. NEAR Snap (HERE Wallet) — best trust-model reference

### Structure & tooling

- Yarn monorepo: `packages/snap`, `packages/sdk` (`@near-snap/sdk`), `packages/site`.
- Deps: `near-api-js`, `@near-js/*`, `tweetnacl`; older pre-JSX snaps API (`panel()/heading()/text()/copyable()`).

### Manifest permissions (v0.7.0)

```json
"initialPermissions": {
  "snap_manageState": {}, "snap_dialog": {}, "snap_notify": {},
  "endowment:rpc": { "dapps": true, "snaps": false },
  "snap_getBip32Entropy": [
    { "path": ["m", "44'", "397'", "0'"], "curve": "ed25519" },
    { "path": ["m", "44'", "1'", "0'"],  "curve": "ed25519" }
  ]
}
```

**No `endowment:network-access`** — "works without internet access"; all chain I/O is the dapp's job. Separate coin types for mainnet (397') vs testnet (1') ⇒ unlinkable keys per network.

### Key derivation

`snap_getBip32Entropy` ed25519 → hex→bytes seed → `nacl.sign.keyPair.fromSeed(seed)` → `KeyPair.fromString()`. Account ID = hex pubkey (implicit account) or bound nickname (`near_bindNickname`).

### RPC surface (schema-validated; errors sanitized to prevent info leaks)

| Method                                                     | Purpose                            |
| ---------------------------------------------------------- | ---------------------------------- |
| `near_getAccount`                                          | address/pubkey                     |
| `near_needActivate`                                        | does implicit account need funding |
| `near_connect` / `near_disconnect` / `near_getPermissions` | per-origin permission grants       |
| `near_bindNickname`                                        | named account binding              |
| `near_signMessage`                                         | NEP-413 off-chain sign             |
| `near_signDelegate`                                        | meta-transaction (gas-free relay)  |
| `near_signTransactions`                                    | sign array of txs                  |

### Permission model (the most distinctive design)

- State: `state[network][origin][contractId] = [methods]`.
- `near_connect` shows a confirm dialog, persists the grant.
- Then a tx that is a **single FunctionCall, 0 deposit, to a permitted contract/method is signed silently** — rate-limited to 1 per 30s, with a `snap_notify` after. This reproduces NEAR's function-call-key UX inside MetaMask.
- Pitfall found: `params.methods ?? []` — omitted methods default to _all-methods_ access.

### Sign flow details

- Dapp supplies `nonce` and `recentBlockHash` (snap has no network). Dapp can pass a `hintBalance` for display.
- Dialogs decode per-action; **FT transfers decoded to human units via a bundled token registry**; deposits via `formatNearAmount`; gas as TGas; AddKey/DeleteKey show pubkey + permissions.
- NEP-413: Borsh payload `{ tag: 2147484061, message, nonce[32], recipient, callbackUrl? }`, 32-byte nonce enforced.

### Dapp integration

`@near-snap/sdk`: `NearSnap` class (snap id `npm:@near-snap/plugin`), typed wrappers, `NearSnapAccount` = near-api-js-style account that signs via snap, broadcasts via dapp's own RPC. Official **`@near-wallet-selector/near-snap`** module ⇒ listed wallet in any wallet-selector dapp.

---

## 4. Existing Stellar snap — `stellar-snap` (paulfears / "MetaStellar")

The **only** Stellar/Soroban snap found on snaps.metamask.io. Allowlisted & audited (Cure53 v1.0.6, MetaMask internal v1.0.7, Snapper v1.0.9) but effectively one-maintainer, <1K installs, `platformVersion 6.10.0` (pre-JSX era).

### Manifest (v1.0.9)

```json
"initialPermissions": {
  "snap_dialog": {}, "snap_notify": {},
  "endowment:page-home": {}, "snap_manageState": {},
  "endowment:rpc": { "dapps": true, "snaps": true },
  "snap_getEntropy": {},
  "endowment:network-access": {},
  "endowment:lifecycle-hooks": {},
  "endowment:cronjob": { "jobs": [{ "expression": "* * * * *", "request": { "method": "NotificationEngine" } }] }
}
```

### Key derivation — the critical finding

Does **NOT** use BIP-32/44 derivation. Uses `snap_getEntropy` with a **salt string** per account:

```javascript
const entropy = await snap.request({
  method: 'snap_getEntropy',
  params: { version: 1, salt },
});
const seed = Wallet.fromHexString(entropy).slice(0, 32);
let keyPair = Keypair.fromRawEd25519Seed(seed);
```

First account salt is literally `"foo"`, later accounts `"salt "+(n+1)`. Addresses are recoverable from the MetaMask SRP + this algorithm, but **incompatible with SEP-0005 (`m/44'/148'/x'`)** — the same mnemonic in Freighter/Ledger/Lobstr yields different addresses. Also supports raw-secret `importAccount` (stored in snap state) and `dispPrivateKey` export.

### RPC surface (~25 methods)

`getAddress`, `getCurrentAccount`, `setCurrentAccount`, `createAccount`, `listAccounts`, `renameAccount`, `importAccount`, `showAddress`, `getBalance`, `getAssets`, `getAccountInfo`, `transfer`, `signTransaction`, `signAndSubmitTransaction`, `signStr`, `sendAuthRequest`, `fund` (friendbot), federation methods, `dispPrivateKey`, `openSendXLM`, `getDataPacket`. Networks: mainnet/testnet/futurenet. Dapps use a `callMetaStellar(method, params)` helper — no wallet-kit/connector package.

### Other

- In-snap Horizon client + Soroban RPC (`soroban_rpc.ts`), internal `TransactionAnalizer.ts` for tx display, home page, interactive screens, per-minute cronjob notification engine.
- Site: SvelteKit demo at stellar-wallet-demo.vercel.app; docs org github.com/metastellar-io.

---

## 5. Cross-cutting comparison

| Aspect                 | XRPL                         | Sui                                           | NEAR                                                                               | Stellar (existing)                          |
| ---------------------- | ---------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| Entropy                | BIP-44 coin 144 (secp256k1)  | BIP-32 m/44'/784' ed25519 + SLIP10 in-snap    | BIP-32 m/44'/397'/0' & m/44'/1'/0' ed25519                                         | `snap_getEntropy` + salt (**non-standard**) |
| Keypair lib            | ripple-keypairs + key-tree   | @mysten/sui Ed25519Keypair                    | tweetnacl → @near-js/crypto                                                        | stellar-base `fromRawEd25519Seed`           |
| Network access in snap | Yes (autofill + broadcast)   | Yes (dry-run + optional execute)              | **No** (dapp broadcasts, supplies nonce/blockhash)                                 | Yes (Horizon + Soroban RPC + cron)          |
| Tx preview             | Per-type strategy dialogs    | **Simulation-driven: fees + balance changes** | Per-action decode, FT amounts via token list                                       | Internal TransactionAnalizer                |
| Dapp integration       | direct invokeSnap            | **wallet-standard adapter pkg**               | typed SDK + official wallet-selector module                                        | code snippets only                          |
| Connect model          | none (silent getAccount)     | none (admin methods origin-gated)             | **explicit connect + per-origin grants + silent 0-deposit calls (30s rate limit)** | per-method dialogs                          |
| State                  | networks (encrypted default) | fullnode URLs only                            | permissions, nicknames                                                             | multi-account metadata, imported keys       |

## 6. Takeaways for the Stellar/Soroban snap

1. **Differentiator #1: SEP-0005-compatible derivation** — use `snap_getBip32Entropy` with `["m","44'","148'"]`, curve ed25519, derive `m/44'/148'/x'` in-snap via SLIP10Node (Sui pattern). Same MetaMask SRP → same addresses as Freighter/Ledger/Lobstr would derive from that mnemonic. The incumbent snap can't fix this without breaking its users.
2. **Simulate-before-sign** (Sui pattern) maps perfectly onto Soroban's mandatory `simulateTransaction` step — show resource fees, balance/state changes, auth entries in the dialog.
3. **Ship a connector package** implementing the de-facto Stellar wallet interface (Freighter-compatible API + Stellar Wallets Kit module) — NEAR/Sui show this is what drives adoption; the incumbent has none.
4. **Origin-gate everything**; don't repeat XRPL's silent `getAccount`. Consider NEAR-style per-origin connect grants.
5. Keep keys **derived on demand, never stored** (Sui/NEAR pattern); avoid private-key export methods, or gate hard if product requires it.
6. Decide network-access model deliberately: in-snap Horizon/RPC calls enable autofill (sequence numbers, fees) + simulation, at the cost of the `endowment:network-access` trust surface. Sui/XRPL say yes; NEAR says no. For Soroban simulation quality, **yes** is likely right.
7. Whitelist supported operation types in dialogs (XRPL pattern); render unknown ones as an explicit "raw XDR" warning path.
