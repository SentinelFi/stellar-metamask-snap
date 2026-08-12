# Multi-account support: research and design proposal

> Written 2026-08-12. Status: research complete, design proposed, implementation not started. Resolves PLAN.md open question 1 ("Multiple accounts in v1, or single account like Sui? Leaning: support index param in API from day 1, UI for it later"): the API groundwork shipped in v1, this document designs the "UI for it later" half.

## 1. Where the codebase stands today

The snap was built multi-account-ready but pins everything to index 0:

| Touchpoint | Current behavior |
| --- | --- |
| [keys/index.ts](../../packages/snap/src/keys/index.ts) | `deriveKeypair(index = 0)` already derives `m/44'/148'/{index}'` for any hardened index; only ever called with 0 (`getWalletAddress` hardcodes it) |
| [snap.manifest.json](../../packages/snap/snap.manifest.json) | `snap_getBip32Entropy` grants the whole `m/44'/148'` subtree (ed25519), so **no manifest change, no re-consent, and no shasum-relevant permission change is needed** to add accounts. THREAT-MODEL §5 documents this as the deliberate reason the subtree was kept |
| [handlers/sign.tsx](../../packages/snap/src/handlers/sign.tsx) | All three signing methods accept a SEP-43 `address` option and reject with "Unknown address: this wallet cannot sign for it" when it differs from account 0 |
| [handlers/access.tsx](../../packages/snap/src/handlers/access.tsx) | `requestAccess` / `getAddress` return the single account 0 address |
| [state/index.ts](../../packages/snap/src/state/index.ts) | `SnapState` v1 has no account field. **Caution:** `parseState` resets any state that does not match the v1 schema to defaults. A v2 schema therefore needs an explicit v1-to-v2 migration path, otherwise upgrading wipes every origin grant and tracked token |
| [handlers/home.tsx](../../packages/snap/src/handlers/home.tsx) | Home page renders one address, its balances, tokens, connected sites; interaction already flows through `onUserInput` (disconnect/remove-token buttons) |
| [handlers/account.tsx](../../packages/snap/src/handlers/account.tsx) | `fund` targets "the wallet address" (account 0); `getBalances` already accepts an arbitrary validated address |
| Tests | SEP-0005 official vector mnemonic is already the test fixture, and `SEP5_ADDRESS_1` (index 1) is already defined in [soroban.test.tsx](../../packages/snap/src/soroban.test.tsx); the SEP-0005 spec publishes vectors for indices 0 through 9 |

## 2. Ecosystem survey

### SEP-0005 (derivation)

`m/44'/148'/x'` with ed25519 SLIP-10, hardened-only. There is no BIP-44 change/address depth for Stellar: one account index per keypair. There is also **no gap-limit discovery convention**: Stellar wallets do not scan for used accounts the way Bitcoin wallets scan addresses; they either expose a fixed index 0 (Ledger default, Sui-snap style) or let the user add accounts explicitly with sequential indices (Freighter, Solar).

### SEP-43 (wallet API, the surface we implement)

- `getAddress()` returns a single `{ address }`: "the public key the wallet is signing for". No account-list method exists in the standard.
- Every signing method takes an optional `address` in its option bag: "If a wallet holds numerous addresses, it can use this param to ensure it is signing with the intended address."
- So the standard's multi-account model is: the wallet owns account selection, the dapp pins its expectation via `address`. Nothing more is required of us.

### Freighter (compatibility target)

- Accounts are added manually from the extension UI, one per click, sequential SEP-0005 indices, plus imported raw keys (out of scope for us, see §5).
- Account selection is **extension-global**: one active account, every connected dapp sees it change.
- Signing docs: "Request a specific account's signature. Freighter will **switch to that account if available**." An `address` naming a known account signs with that account; it is not an error just because it is not the currently active one.

### Other snaps (from [example-snaps-analysis.md](example-snaps-analysis.md))

- Sui snap: single account only, index 0, no selector. Simple but users ask for more.
- The incumbent stellar-snap: full multi-account surface (`createAccount`, `listAccounts`, `setCurrentAccount`, `renameAccount`) but non-SEP-0005 derivation (`snap_getEntropy` + string salts) and raw-key import stored in snap state, both of which we rejected in Phase 0.
- MetaMask's own multichain accounts (native Solana/Bitcoin) run on preinstalled first-party snaps and the keyring API, which is **not open to third-party non-EVM snaps** ([metamask-snaps-platform.md](metamask-snaps-platform.md)). A Stellar snap manages accounts internally in state, like every other non-EVM snap in the directory.

### Platform UI capability

The snaps JSX library (platformVersion 10.3.0) provides interactive `Button`, `Form`, `Input`, `Dropdown`, `Selector`, and `Card` components on the home page, handled through `onUserInput`. This is enough for add/switch/rename without any new permission.

## 3. Proposed design

### 3.1 Account model: explicit sequential accounts, one wallet-global active account (Freighter parity)

- State tracks `accountCount` (how many the user has added) and `activeIndex`. Account `x` exists iff `x < accountCount`. Adding an account appends index `accountCount` (no holes, deterministic recovery: a restored wallet re-adds accounts in order and gets the same addresses).
- No automatic discovery scan in v1. Optional later: an "import existing accounts" helper that probes Horizon for funded accounts at indices `0..N` and offers to add them, strictly user-initiated.
- Cap `MAX_ACCOUNTS` at 20: keeps the home page renderable and state small; nobody hits 20 sequential SEP-0005 accounts in practice, and the cap can be raised without migration.
- Optional per-account label (user-supplied, sanitized with the existing `sanitizeInlineText`, length-capped, never shown bare without the address). Addresses are never stored: they re-derive on demand, preserving the "no key material or derived identifiers in state" property (an address in state would be harmless cryptographically but is one more thing the schema validator must defend).

### 3.2 RPC surface: no new methods in v1

- `requestAccess` / `getAddress` return the **active** account's address (SEP-43 and Freighter semantics unchanged).
- The signing methods' `address` option changes from "must equal account 0" to "**resolve across the user's added accounts**": if `address` matches the derived address of any index `< accountCount`, sign with that account (the dialog names it, see §3.4); if it matches nothing, keep today's "Unknown address" rejection. This is exactly Freighter's "switch to that account if available" behavior and is what wallets-kit dapps expect after the user picks an account.
- `fund` (no per-call dialog) funds the **active** account only, as today. It must not accept the address option for non-active accounts, because resolution there would let a connected origin enumerate which addresses belong to this wallet by probing `fund({ address })` for errors. Signing methods do not have this problem: they always end in a dialog, so probing costs a visible prompt per guess.
- Account management (add, switch, rename) stays **user-only on the home page** in v1: no `setActiveAccount`/`listAccounts` RPC. Rationale: every RPC method is attack surface with its own consent design; Freighter also exposes no dapp-facing account management. A dapp that wants another account asks the user in its own UI and passes `address`.

### 3.3 State schema v2 with a real migration

```ts
type SnapStateV2 = {
  version: 2;
  network: NetworkName;
  origins: Record<string, { connectedAt: string }>;
  tokens?: Partial<Record<NetworkName, TrackedToken[]>>;
  accounts: {
    /** Indices 0..count-1 exist. */
    count: number;      // 1..MAX_ACCOUNTS
    active: number;     // 0..count-1
    /** Optional user labels, keyed by stringified index. */
    labels?: Record<string, string>;
  };
};
```

- `parseState` becomes `migrateState`: a stored v1 object upgrades in place to `{ ...v1, version: 2, accounts: { count: 1, active: 0 } }`; only truly unrecognizable state falls back to defaults. Grants and tokens survive the upgrade. This needs its own tests (v1 payload in, v2 out, nothing lost).
- Every read of `accounts` re-validates bounds (`Number.isInteger`, `0 <= active < count <= MAX_ACCOUNTS`) before an index reaches `deriveKeypair`, mirroring how `readTokenBalance` re-validates decimals from state.

### 3.4 UI

- **Home page**: an "Accounts" section listing each account as truncated address (plus label), active one marked, with `Switch` buttons, an `Add account` button, and the existing sections keyed off the active account. Balances/tokens continue to show for the active account only (one Horizon call per render, unchanged cost).
- **Switch confirmation**: switching is low-risk (both accounts belong to the user) but changes what every connected origin sees, so the switch re-renders the page immediately and the account section states "Connected sites see the active account".
- **Signing dialogs**: already print the full signing address in a `Copyable` ("Signing with"). With address resolution (§3.2) this becomes load-bearing: when a dapp pins a non-active account, the dialog is where the user sees which of their accounts signs. Add the account label/index next to the address ("Account 2 of 3") so the user recognizes it as one of theirs.
- **Add-account flow**: one click, no dialog needed (deriving a public address discloses nothing and moves nothing), page re-renders with the new account. Renaming uses a small `Form` + `Input`, sanitized.

### 3.5 What deliberately does not change

- Manifest and permissions: none. The subtree grant already covers all hardened indices (THREAT-MODEL §5 "Entropy scope").
- Origin grants stay origin-scoped, not (origin, account)-scoped, matching Freighter. Privacy consequence documented in §4.
- Key handling: derive on demand, sign, discard. No new persistence.
- Connector: no API change required for v1 (the `address` option already passes through). A `getAccounts`-style extension can come later if dapp demand appears.

## 4. Security and privacy analysis

| Concern | Assessment |
| --- | --- |
| Index bounds | `deriveKeypair` must only ever see validated integers `0..MAX_ACCOUNTS-1` from state. Hardened SLIP-10 derivation means even an out-of-range index would only produce another key the user owns, but bounds-check anyway (state corruption defense, consistent with existing patterns) |
| Address resolution in signing | Resolving the dapp's `address` across up to 20 accounts requires up to 20 derivations per signing request (one `snap_getBip32Entropy` call plus cheap SLIP-10 child derivations; in practice derive the subtree node once and derive children from it). No timing/oracle concern: the method always ends in either a dialog or an "Unknown address" error, same as today |
| Wallet-address enumeration | A connected origin could distinguish "one of your accounts" from "not yours" by passing candidate addresses to signing methods and watching for the dialog vs the error. That is already true today for account 0 (the error is the same), is inherent to SEP-43's option-bag semantics, and costs one visible dialog per confirmed hit. Keep `fund` active-account-only so no silent method gains this oracle |
| Privacy across origins | With a global active account, switching reveals the new address to every origin holding a grant (via `getAddress`). Same model as Freighter. The home page copy must say so. Per-origin account pinning was considered and rejected for v1: it diverges from Freighter's mental model, complicates the grant schema, and dapps that care already pin via `address` |
| Migration | The dangerous failure is silent state reset (looks like the wallet forgot every connection and token; users would read it as theft). Migration must be additive and covered by tests before `version: 2` ships |
| Labels | User-supplied text rendered on the home page and in dialogs: run through `sanitizeInlineText`, cap length (32 chars), never render a label without its address, so a label like "Ledger cold storage" cannot masquerade as a different account's identity |
| Consent model | Unchanged. Adding/switching accounts is user-initiated on the home page; no dapp can add, switch, enumerate, or rename accounts; signatures still always require a per-request dialog |

Threat-model deltas to write when implementing: update §1 assets (one key per account index, all under the same subtree), §5 entropy-scope entry (now exercised), and the residual-risks list (address-enumeration oracle, global-active-account privacy note).

## 5. Out of scope (deliberate)

- **Raw-key import** (Freighter and the incumbent snap have it): requires persisting secrets in snap state, which violates the "no key material in state" invariant that the audit and threat model are built on. Users who need imported keys have Freighter.
- **Keyring API / MetaMask-native account rows**: not available to third-party non-EVM snaps.
- **Automatic funded-account discovery at install**: adds Horizon calls and surprise; a user-initiated "scan for my accounts" helper can come later.
- **Muxed (M...) addresses**: orthogonal feature, already tracked in PLAN.md Phase 4 leftovers.

## 6. Implementation plan (when green-lit)

1. **State v2 + migration** (`state/index.ts`): schema, `migrateState` with tests proving v1 grants/tokens survive; bounds-validated `getAccounts()`/`setActiveAccount()`/`addAccount()` helpers under the existing mutation lock.
2. **Keys** (`keys/index.ts`): `getWalletAddress(index?)` reads the active index from state; add `resolveSigningAccount(address?)` that returns `{ keypair, index }` for the active account or the matching added account, deriving the subtree node once.
3. **Signing paths** (`handlers/sign.tsx`): swap the three `request.address` equality checks for `resolveSigningAccount`; pass the account index/label into the dialogs; `connectOrigin` unchanged.
4. **Home page** (`handlers/home.tsx`, `index.tsx` `onUserInput`): accounts section, add/switch/rename events, copy about connected sites seeing the active account.
5. **Dialogs** (`ui/transaction.tsx`, `ui/dialogs.tsx`): "Signing with" gains the account ordinal/label.
6. **Tests**: SEP-0005 vectors for indices 0, 1, 2 (spec publishes 0 through 9); migration; address-resolution signing (active, non-active, unknown); home-page interaction flows; `fund` still active-only.
7. **Docs**: THREAT