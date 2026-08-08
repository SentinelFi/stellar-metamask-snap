# MetaMask Snaps Platform — Knowledge Base

> Research snapshot: 2026-08-08. Sources: docs.metamask.io/snaps, snaps.metamask.io, MetaMask GitHub repos.
> Purpose: everything needed to build, test, and ship a non-EVM (Stellar) snap.

## 1. What a snap is & how it runs

- A snap is a JavaScript program published as a **single bundled `.js` file**, executed inside MetaMask in an isolated **SES (Hardened JavaScript)** sandbox (iframe), with LavaMoat dependency policies at build time.
- **Default globals**: standard JS, `console`, timers, `SubtleCrypto` (WebCrypto), `TextEncoder/Decoder`, `atob/btoa`, `URL`, and the snaps-specific `snap` global (`snap.request({...})`).
- **Permission-gated globals**: `fetch` (`endowment:network-access`), `WebAssembly` (`endowment:webassembly`), `ethereum` EIP-1193 provider (`endowment:ethereum-provider`, read-only).
- **Limitations**: no DOM, no Node built-ins (polyfill at bundle time), no `XMLHttpRequest`, no WebSockets.
- **Lifecycle**: event-driven; snap is terminated after **30s idle** and requests are killed after **60s** (extendable via `maxRequestTime` caveat: 5,000–180,000 ms).
- Snaps can never read the SRP directly — only the entropy methods expose derived key material, and those permissions are audit-gated for distribution.

## 2. Project anatomy

### snap.manifest.json (template example)
```json
{
  "version": "0.1.0",
  "description": "An example Snap written in TypeScript.",
  "proposedName": "TypeScript Example",
  "repository": { "type": "git", "url": "https://github.com/.../repo.git" },
  "source": {
    "shasum": "<computed by mm-snap build>",
    "location": {
      "npm": { "filePath": "dist/bundle.js", "packageName": "snap", "registry": "https://registry.npmjs.org/" }
    }
  },
  "initialPermissions": { "snap_dialog": {}, "endowment:rpc": { "dapps": true, "snaps": false } },
  "platformVersion": "10.3.0",
  "manifestVersion": "0.1"
}
```
- `version` must match `package.json` (update package.json first; build syncs manifest).
- `source.shasum` = bundle integrity hash, recomputed by `mm-snap build` / `mm-snap manifest --fix`; verified at install.
- `initialConnections` — dapp origins auto-connected without a confirmation prompt: `"initialConnections": { "https://mydapp.example": {} }`.
- `package.json`: `name` must match `source.location.npm.packageName`, `repository.url` must be the real repo.

### Tooling
- Scaffold: `yarn create @metamask/snap <name>` → TypeScript+React monorepo: `packages/snap` + `packages/site` (companion dapp). Prereqs: **MetaMask Flask**, Node ≥ 20.11, Yarn.
- CLI `@metamask/snaps-cli` (`mm-snap`): `build` (webpack, `--analyze`), `watch`, `serve` (default port 8081; template wires 8080), `eval` (run bundle in SES to catch incompatibilities), `manifest --fix`, `sandbox` (interactive test UI, ≥7.1.0).
- `snap.config.ts`: `{ input, output: { path }, server: { port }, sourceMap, polyfills, environment, customizeWebpackConfig, ... }`.
- JSX UI TypeScript setup: tsconfig `"jsx": "react-jsx"`, `"jsxImportSource": "@metamask/snaps-sdk"`, files `.tsx`, import from `@metamask/snaps-sdk/jsx`.

## 3. Permissions reference

### Endowments
| Permission | Grants | Manifest shape |
|---|---|---|
| `endowment:rpc` | `onRpcRequest` | `{"dapps": true, "snaps": false}` or `{"allowedOrigins": [...]}` |
| `endowment:keyring` | Keyring API / `onKeyringRequest` | `{"allowedOrigins": ["https://dapp"]}` |
| `endowment:transaction-insight` | `onTransaction` (EVM txs) | `{"allowTransactionOrigin": true}` |
| `endowment:signature-insight` | `onSignature` (EVM sigs) | `{"allowSignatureOrigin": true}` |
| `endowment:cronjob` | `onCronjob` | `{"jobs": [{"expression": "* * * * *", "request": {"method": "..."}}]}` |
| `endowment:page-home` | `onHomePage` | `{}` |
| `endowment:lifecycle-hooks` | `onInstall` / `onUpdate` | `{}` |
| `endowment:network-access` | global `fetch` | `{}` |
| `endowment:ethereum-provider` | `ethereum` global (read-only) | `{}` |
| `endowment:name-lookup` | `onNameLookup` | `{"chains": ["eip155:1"], "matchers": {...}}` |
| `endowment:webassembly` | `WebAssembly` | `{}` |

`maxRequestTime` caveat applies to: cronjob, keyring, lifecycle-hooks, name-lookup, page-home, rpc, transaction-insight.

> `endowment:page-settings` / `onSettingsPage`: exists in MetaMask source (preinstalled snaps) but **not in public docs** as of Aug 2026 — treat as unavailable to third parties.

### Restricted methods (snap_*)
`snap_dialog`, `snap_manageState`, `snap_notify`, `snap_getPreferences` (supersedes `snap_getLocale`), `snap_getFile`, `snap_manageAccounts`, entropy methods:
```json
"snap_getBip32Entropy":   [{ "path": ["m", "44'", "148'"], "curve": "ed25519" }],
"snap_getBip32PublicKey": [{ "path": ["m", "44'", "148'", "0'"], "curve": "ed25519" }],
"snap_getBip44Entropy":   [{ "coinType": 148 }],
"snap_getEntropy": {}
```

## 4. Entry points

All named exports; types from `@metamask/snaps-sdk`.

| Handler | Permission | Params → Returns |
|---|---|---|
| `onRpcRequest` | `endowment:rpc` | `{ origin, request }` → any JSON |
| `onTransaction` | transaction-insight | `{ transaction, chainId, transactionOrigin? }` → `{ content }` or `{ id }`, optional `severity: 'critical'` |
| `onSignature` | signature-insight | `{ signature, signatureOrigin? }` → `{ content, severity? }` |
| `onCronjob` | cronjob | `{ request }` → Promise |
| `onHomePage` | page-home | none → `{ content }` or `{ id }` |
| `onInstall` / `onUpdate` | lifecycle-hooks | none → Promise (welcome dialog / migrations) |
| `onUserInput` | (with interactive UI) | `{ id, event: { type, name?, value? }, context }` |
| `onKeyringRequest` | keyring | `{ origin, request }` → route to `handleKeyringRequest` |
| `onNameLookup` | name-lookup | `{ chainId, address?\|domain? }` → resolutions or null |

Not public yet (in-flight SIPs / preinstalled-only): `onSettingsPage`, `onProtocolRequest`, `onAssetsLookup`/`onAssetsConversion`.

## 5. Key derivation (the critical part for Stellar)

- **`snap_getBip44Entropy`** — BIP-44 coin-type node `m/44'/coin'`, **secp256k1 only**. Not usable for Stellar (ed25519).
- **`snap_getBip32Entropy`** — SLIP-10 node at arbitrary path with curve `"secp256k1"`, `"ed25519"`, or `"ed25519Bip32"` (Cardano-style). Optional `source` for multi-SRP (`snap_listEntropySources`). Returns JSON node → rehydrate with `SLIP10Node.fromJSON(node)` from `@metamask/key-tree`, then `node.derive(["slip10:0'"])`. **ed25519 = hardened-only segments.** This is the Stellar path: manifest caveat `{"path": ["m","44'","148'"], "curve": "ed25519"}`, then derive account index in-snap.
- **`snap_getBip32PublicKey`** — public key only, no private material; recommended whenever only addresses are needed. (Note: for ed25519 the pubkey it returns has a leading 0x00 byte convention from SLIP-10 — handle when encoding.)
- **`snap_getEntropy`** — snap-specific 256-bit entropy from SRP+snapId+salt. Good for snap-private secrets (e.g. nothing chain-interoperable). This is what the incumbent stellar-snap misuses for accounts.

Security rules (from docs, binding for audit):
- The manifest path caveat is the only thing limiting which chains' keys a snap can derive — auditors check path matches stated purpose.
- Never return private keys via RPC/network; display secrets only in dialogs; informed consent for irreversible ops; "choose friction over convenience."

## 6. Custom UI (JSX) & interactive UI

- JSX components from `@metamask/snaps-sdk/jsx` (MetaMask 12+; old `panel()/text()` API deprecated).
- **Layout**: `Box` (direction/alignment), `Container` + `Footer` (1–2 buttons), `Section`, `Divider`.
- **Text**: `Text`, `Heading` (sm/md/lg), `Bold`, `Italic`, `Link` (`https:`/`mailto:`/`metamask:`; no `http:`).
- **Forms**: `Form`, `Field`, `Input` (text/number/password), `Checkbox`, `RadioGroup`, `Dropdown`, `Selector`, `FileInput`, `Button` (primary/destructive, button/submit).
- **Data**: `Address` (hex or CAIP-10), `Avatar`, `Row` (label/value + variants), `Value`, `Card`, `Copyable` (also the anti-phishing container for untrusted strings), `Banner` (danger/info/success/warning), `Icon`, `Image` (inline SVG only), `Tooltip`, `Spinner`, `Skeleton`.

### Dialogs (`snap_dialog`)
- `alert` → null; `confirmation` → boolean; `prompt` → string; **custom** (no `type`) → resolved via `snap_resolveInterface`.
- Don't work while MetaMask is locked.

### Interactive interface lifecycle
- `snap_createInterface { ui, context? }` → `id`; use in `snap_dialog { id }` or return `{ id }` from `onHomePage`/`onTransaction`.
- `snap_updateInterface { id, ui, context? }` — e.g. Spinner → fetch → update.
- `snap_getInterfaceState` (form values), `snap_getInterfaceContext`, `snap_resolveInterface { id, value }`.
- `onUserInput` event types: `ButtonClickEvent`, `FormSubmitEvent`, `InputChangeEvent`, `FileUploadEvent`.

## 7. State

- `snap_manageState`: `get` | `update` (replaces whole state) | `clear`. **Encrypted by default** (snap-specific key); encrypted state needs MetaMask unlocked — check `snap_getClientStatus` in cronjobs. `encrypted: false` = separate unencrypted store, usable while locked.
- Size limit: docs say 64 MB in one place, 100 MB in another — plan for 64 MB.
- Newer granular `snap_getState`/`snap_setState`/`snap_clearState` (key-path based) exist in recent SDKs — verify docs before relying on them.

## 8. Network access

- `endowment:network-access` → global `fetch` only. Requests originate from a sandboxed iframe ⇒ **`Origin: null`**; the server must send `Access-Control-Allow-Origin: *` (or `null`) — otherwise you need a proxy.
- **Stellar impact**: Horizon/Soroban RPC endpoints must be CORS-open (SDF testnet endpoints are; verify chosen mainnet providers, else front with a proxy).

## 9. Dapp ↔ snap communication

```js
// connect / install (value may pin a version range)
await window.ethereum.request({
  method: 'wallet_requestSnaps',
  params: { 'npm:my-snap': { "version": "^1.0.0" } },
})
// invoke (wallet_snap is a synonym)
const res = await window.ethereum.request({
  method: 'wallet_invokeSnap',
  params: { snapId: 'npm:my-snap', request: { method: 'hello', params: {...} } },
})
// discover (only snaps connected to THIS dapp)
const snaps = await ethereum.request({ method: 'wallet_getSnaps' })
```
- Snap IDs: `npm:<packageName>` (published), `local:http://localhost:8080` (dev).
- Rejection: `{ code: 4001, message: 'User rejected the request.' }`.
- **Detection**: EIP-6963 `eip6963:announceProvider`, rdns exact-match `io.metamask` / `io.metamask.flask` / `io.metamask.mmi` (never `includes()` — spoofable). Probe snaps support via `wallet_getSnaps` (method-not-found ⇒ unsupported). Unlisted snaps require Flask; allowlisted snaps run on stable MetaMask.

## 10. Keyring API status (why we don't use it)

- Keyring API (`endowment:keyring` + `snap_manageAccounts`, `@metamask/keyring-api`) makes snap accounts first-class in MetaMask UI — but the documented allowlistable surface is **EVM-only** (`eip155:eoa`, `eip155:erc4337`), and docs state: *"MetaMask is not currently accepting allowlisting requests for Custom EVM Account Snaps."*
- Non-EVM account types (`solana:data-account`, bip122) exist in keyring-api but are used only by MetaMask's own **preinstalled** snaps (native Solana/Bitcoin support, shipped 2025 via multichain accounts). Not open to third parties.
- ⇒ A Stellar snap manages accounts internally (entropy + own state) and exposes its own RPC API — the pattern used by every non-EVM snap in the directory.

## 11. Testing

- **Local**: `yarn start` → snap at `localhost:8080`, dapp at `localhost:8000`; install into Flask with snap ID `local:http://localhost:8080`.
- **`@metamask/snaps-jest`**: `preset: '@metamask/snaps-jest'`; tests run against the built bundle.
```js
const { request, onHomePage } = await installSnap()
const response = await request({ origin: 'https://dapp', method: 'foo' })
expect(response).toRespondWith('bar')
// dialog interaction:
const pending = request({ method: 'sign' })
const ui = await pending.getInterface()
await ui.ok()   // or ui.cancel(), ui.clickElement(name), ui.typeInField(...)
```
- Matchers: `toRespondWith`, `toRespondWithError`, `toRender`, `toSendNotification`.
- `mm-snap eval` catches SES incompatibilities at build time — run it in CI.

## 12. Publishing, allowlisting, audits

- Publish to **npm** (public). Stable MetaMask installs **allowlisted snaps only**; Flask installs anything.
- **Open permissions** (no allowlist needed): cronjob, ethereum-provider, lifecycle-hooks, page-home, signature-insight, transaction-insight, snap_dialog, snap_getPreferences, snap_manageState, snap_notify.
- **Allowlist-required**: `endowment:rpc` (to dapps), `endowment:network-access`, `endowment:name-lookup`, `endowment:webassembly`, keyring, all entropy methods.
- **Audit-gated** (third-party audit evidence required): `snap_getBip32Entropy`, `snap_getBip32PublicKey`, `snap_getBip44Entropy`, `snap_getEntropy`, `snap_manageAccounts`. Audit must cover snap source + key-management modules, with audited commit documented. Approved auditors (verify current wiki list): Consensys Diligence, Cure53, Halborn, Least Authority, OtterSec, Sayfer, Veridise.
- Process: Directory Information form → review (≥2 approvals) → listing; **updates are re-submitted per version** (allowlist is version-pinned).
- Also required: public source, Snapper security scan pass, no console logs / TODOs / unused permissions.

## 13. Platform state 2025–2026 (context)

- MetaMask shipped **native Solana (Jul 2025) and Bitcoin** support via multichain accounts (Oct 2025: one EVM + Solana + BTC address per account from the same SRP), built on preinstalled first-party snaps. Stellar has no native support — a third-party snap is the integration path, and if Stellar ever goes native, SEP-0005-compatible derivation is what MetaMask's own snap would use (another reason to match it).
- Current template `platformVersion: 10.3.0`; JSX requires MetaMask 12+.
- Watch `MetaMask/snaps` releases + `MetaMask/SIPs` for: settings pages, `onProtocolRequest`, assets handlers, granular state, `snap_scheduleBackgroundEvent` (documented: one-off scheduled events into `onCronjob`), `snap_trackError`/`snap_trackEvent`.

## Known doc inconsistencies / open questions

- State size: 64 MB vs 100 MB across doc pages.
- `endowment:page-settings`: source-only, not public.
- Granular state methods: in SDK, docs coverage unverified.
