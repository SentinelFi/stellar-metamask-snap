# Multi-Account Support: Research and Design

> Design research for adding multiple SEP-0005 accounts to the Stellar Soroban Snap. Written 2026-08-12. Status: implemented (2026-08-12), per the design below: the `addAccount` RPC was deferred (account creation is home-page only, see section 9.3) and phases 1 to 5 shipped together. Scope: `packages/snap` plus the connector API surface.

## 1. Summary

The snap today exposes exactly one account, SEP-0005 index 0 (`m/44'/148'/0'`). The cryptographic and permission groundwork for more is already in place:

- `deriveKeypair(index = 0)` in [keys/index.ts](../packages/snap/src/keys/index.ts) already derives an arbitrary hardened account index in-snap; only the callers pin `0`.
- The manifest entropy caveat already grants the whole `m/44'/148'` subtree (documented as deliberate in [THREAT-MODEL.md](THREAT-MODEL.md) §5), so no permission change, new shasum, or user re-consent is required to derive additional indices.
- The SEP-43 signing methods already carry an optional `address` option; the snap currently uses it only to reject a mismatch, never to select a different account.

This document surveys how the ecosystem handles multiple accounts, then proposes a design: a wallet-global active account plus an explicit registry of known account indices, an `address` option that resolves to any known account (Freighter parity) instead of rejecting, three small RPC additions, a state schema migration, and the consent and privacy rules that keep the change safe. Backwards compatibility is total: an untouched wallet keeps account 0 as the only, active, default account.

## 2. Goals and non-goals

**Goals**

- Let a user hold and use several SEP-0005 accounts (`m/44'/148'/x'`) from the same MetaMask secret recovery phrase.
- Match Freighter/SEP-43 semantics so existing dapps work unchanged: the `address` option selects the signing account when the wallet holds it.
- Keep every account addressable for read methods (`getBalances`) and signable (`signTransaction`, `signAuthEntry`, `signMessage`).
- Preserve every current security property: display integrity, per-request consent, fail-closed review, no key persistence. Every signing dialog must state which account signs.
- Zero-friction migration: existing state and single-account dapps continue to work with no user action.

**Non-goals (for the first iteration)**

- Importing arbitrary external secret keys (the snap only derives from MetaMask's SRP; importing raw keys is a different trust model, out of scope, see §9).
- Non-SEP-5 derivation, multiple SRPs (`snap_listEntropySources`), or hardware-account bridging.
- Account nicknames/labels persisted across devices (a local display nicety, deferred to §9).
- Per-origin distinct active accounts (a possible later enhancement, see §6.3).

## 3. Ecosystem research

### 3.1 SEP-0005 derivation

Stellar key derivation (SEP-0005) uses BIP-44 paths with three hardened segments: `m/44'/148'/x'`, where `148'` is the Stellar coin type and `x'` is the account index. ed25519 requires every segment hardened. The same mnemonic yields the same ordered sequence of accounts in Freighter, Ledger, Lobstr, and any SEP-5 wallet, which is exactly why the snap derives SEP-5 paths rather than the salt-based scheme the incumbent MetaStellar snap uses (documented in [research/example-snaps-analysis.md](research/example-snaps-analysis.md): that scheme is "incompatible with SEP-0005 ... the same mnemonic in Freighter/Ledger/Lobstr yields different addresses").

Consequence for us: account index `x` is portable. A user who adds account 1 here sees the same G-address for account 1 in Freighter. This is a feature (portability) and a constraint (we must count indices exactly as SEP-5 does, contiguously from 0, no gaps in the canonical ordering).

### 3.2 SEP-43 (the wallet interface we implement)

SEP-43 defines the signing methods with an options bag. On account selection, the spec says:

> Options also allow a wallet to specify which account they're seeking a signature for as `address`. If a wallet holds numerous addresses, it can use this param to ensure it is signing with the intended address.

`getAddress()` returns a single `{ address }` and is documented as "the public key ... which may be the account loaded in the wallet or a different account the wallet signs for." So SEP-43 assumes a single "current" address for `getAddress`, and per-request selection via the `address` option. It does not define a "list all accounts" method; that is wallet-specific.

### 3.3 Freighter (the parity target)

Freighter supports multiple addresses and lets the user switch between them. In its dapp API the signing `address` option means, per its docs, "Request a specific account's signature. Freighter will switch to that account if available." The important detail: a requested address that the wallet holds causes a switch-and-sign, not a rejection. There is no documented error for an address the wallet does not hold; behavior degrades to a failed/again-prompted signature.

Our snap currently does the opposite: [sign.tsx](../packages/snap/src/handlers/sign.tsx) throws `invalidRequest('Unknown address: this wallet cannot sign for it.')` for any `address` that is not account 0. Reaching Freighter parity means resolving the `address` to an owned account index and signing with it, and only rejecting when the address is genuinely not ours.

### 3.4 Other MetaMask snaps

From [research/example-snaps-analysis.md](research/example-snaps-analysis.md):

- **MetaStellar** exposes a full account-management RPC surface: `getCurrentAccount`, `setCurrentAccount`, `createAccount`, `listAccounts`, `renameAccount`, plus raw-secret `importAccount` and `dispPrivateKey` export. It stores multi-account metadata and imported keys in snap state. Its derivation is non-SEP-5, and it exports private keys, both of which we deliberately reject; but its RPC shape (`list` / `create` / `setCurrent`) is a reasonable template for the derive-only subset.
- **Sui snap**: single account only, same address as the native Sui Wallet for the mnemonic. Shows single-account is an acceptable launch posture (which is where we are today).
- **NEAR snap**: `near_getAccount` plus nickname binding; no BIP-44 index model (NEAR uses implicit accounts), so less applicable.

Design takeaways: keep the derive-only subset (`list` / `add` / `setActive`), never add `import`/`export`, and store only non-secret metadata (indices, optional local labels) in state, consistent with our "no key material in state" invariant.

## 4. Current code: where account 0 is hardcoded

The change surface is small and localized:

| Location                                                                                     | Current behavior                            | Change                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| [keys/index.ts:16](../packages/snap/src/keys/index.ts:16) `deriveKeypair(index = 0)`         | Already index-parameterized                 | No change to the core; keep default 0                                             |
| [keys/index.ts:40](../packages/snap/src/keys/index.ts:40) `getWalletAddress()`               | Derives index 0                             | Add `getAddressForIndex(index)`; make `getWalletAddress` resolve the active index |
| [handlers/access.tsx:16,56](../packages/snap/src/handlers/access.tsx:16)                     | `getWalletAddress()` (index 0)              | Return the active account's address                                               |
| [handlers/sign.tsx:87,296,386](../packages/snap/src/handlers/sign.tsx:87) `deriveKeypair(0)` | Signs with index 0; rejects other `address` | Resolve `address` option to an owned index, derive that, else reject              |
| [handlers/account.tsx:63,87](../packages/snap/src/handlers/account.tsx:63)                   | `fund`/`getBalances` default to index 0     | Default to active account; allow any owned account                                |
| [handlers/home.tsx:132](../packages/snap/src/handlers/home.tsx:132)                          | Renders index 0                             | Render the active account, with a switch/add UI                                   |
| [state/index.ts](../packages/snap/src/state/index.ts) `SnapState` (version 1)                | No account fields                           | Add `activeAccount` + `accounts`; bump to version 2 with migration                |

Test fixtures already contain the first two SEP-5 vector addresses (index 0 `GDRXE2...UJ6`, index 1 `GBAW5X...JQX` in [soroban.test.tsx](../packages/snap/src/soroban.test.tsx)), so multi-index derivation is already verifiable against the official vectors.

## 5. Proposed design

### 5.1 Account model

Introduce two pieces of persisted state:

- `activeAccount: number` — the SEP-5 index whose address `getAddress` returns and which signing/read methods use by default. Defaults to `0`.
- `accounts: number[]` — the set of account indices the user has revealed ("knows about"), always including `0`. Contiguous from 0 in the canonical case, but stored explicitly so the set is authoritative rather than inferred.

Rationale for an explicit registry rather than "just derive any index on demand": it bounds which addresses the wallet will act for. An origin passing an `address` option can only cause a signature for an account the user has deliberately revealed, never an arbitrary deep index the user has never seen. It also gives the home page a concrete list to render, and keeps `getBalances(address)` honest about what "our" accounts are.

### 5.2 Resolving the `address` option (the core behavioral change)

Replace the current reject-on-mismatch with resolve-then-sign, staying fail-closed:

```
resolveSigningIndex(requestedAddress?):
  if requestedAddress is undefined:            # SEP-43: no selection → active account
      return state.activeAccount
  for index in state.accounts:                 # only accounts the user has revealed
      if getAddressForIndex(index) == requestedAddress:
          return index
  throw invalidRequest('Unknown address: this wallet does not hold it.')
```

This matches Freighter's "sign with that account if available" while keeping our stronger guarantee: the wallet signs only for accounts the user has explicitly added. We do **not** auto-scan an unbounded gap window to discover the index of an arbitrary address; that would let an origin probe/derive accounts the user never chose to reveal. Revealing accounts is always a user-initiated action (§5.4).

Deriving one address per known account for each match is cheap (SLIP-10 is fast and local) and bounded by the small `accounts` set; addresses can be memoized within a request.

### 5.3 `getAddress` / `requestAccess` semantics

Unchanged in shape (`{ address }`), now returns the **active** account's address for a connected origin (and `''` when not connected, exactly as today). Switching the active account changes what every connected origin subsequently sees, the same wallet-global model already used for the network switch (`setNetwork`). A new `getAccounts` method (§5.5) is the multi-account-aware way for a dapp to enumerate.

### 5.4 Adding an account (user-initiated, dialog-confirmed)

Two entry points, both requiring explicit user consent:

- **Home page** ("Add account" button under the account section): reveals the next contiguous index (`max(accounts) + 1`), shows its address in a confirmation dialog, and on approval appends it to `accounts`. No dapp involvement.
- **RPC `addAccount`** (optional, for dapp-driven flows): a connected origin requests that the wallet reveal a new account; the snap shows an "Add account N (G...)" confirmation and, on approval, appends and returns it. Rejection returns SEP-43 `-4`. This is a convenience; the home-page path is the primary one.

Revealing the _next_ index only (never an arbitrary jump) keeps the account set contiguous and portable with other SEP-5 wallets, and prevents an origin from steering the user toward a surprising deep index.

### 5.5 New RPC methods

| Method             | Origin gate                    | Dialog                              | Returns                                           |
| ------------------ | ------------------------------ | ----------------------------------- | ------------------------------------------------- |
| `getAccounts`      | connected (like `getBalances`) | none (read)                         | `{ accounts: { index, address }[], activeIndex }` |
| `setActiveAccount` | connected (like `setNetwork`)  | confirmation (wallet-global change) | `{ index, address }`                              |
| `addAccount`       | connected                      | confirmation                        | `{ index, address }`                              |

`getAccounts` is the enumeration method SEP-43 lacks; it discloses only addresses for accounts the origin's user has already revealed, and only to connected origins (no new fingerprinting surface beyond the active address a connected origin already sees). `setActiveAccount` mirrors `setNetwork`: wallet-global, dialog-confirmed, reserved for connected origins, re-read under the state lock after the dialog to avoid a stale-snapshot clobber (the pattern already in [state/index.ts](../packages/snap/src/state/index.ts) `setActiveNetwork`).

The signing methods (`signTransaction`, `signAuthEntry`, `signMessage`) gain no new parameters: they already accept `address`, and now resolve it via §5.2.

### 5.6 State schema and migration

Bump `SnapState` to `version: 2`:

```ts
type SnapState = {
  version: 2;
  network: NetworkName;
  activeAccount: number; // NEW, default 0
  accounts: number[]; // NEW, default [0]
  origins: Record<string, { connectedAt: string }>;
  tokens?: Partial<Record<NetworkName, TrackedToken[]>>;
};
```

`parseState` in [state/index.ts:78](../packages/snap/src/state/index.ts:78) currently resets anything that fails the version-1 struct to defaults. Add a migration: a valid version-1 object is upgraded in place by setting `activeAccount: 0`, `accounts: [0]`, `version: 2`, preserving `network`, `origins`, and `tokens`. Anything that matches neither schema still resets to a fresh default (now version 2). This keeps the "corrupt/unknown state resets safely" invariant while not discarding a legitimate pre-migration wallet's grants and tokens.

New indices must be validated on the way in: `Number.isInteger`, `>= 0`, and `< MAX_ACCOUNT_INDEX` (a sane cap, e.g. 256, so a corrupt or hostile state value can never drive an absurd derivation). `activeAccount` must always be a member of `accounts`; the parser coerces a stray active index back to `0` rather than trusting it.

### 5.7 UI changes

- **Home page** ([handlers/home.tsx](../packages/snap/src/handlers/home.tsx)): show the active account with its address and balances (as today), plus a compact account list with a "Use" (switch active) action per account and an "Add account" button. Each account row shows the index and truncated address (full address in a `Copyable`).
- **Signing dialogs** ([ui/transaction.tsx](../packages/snap/src/ui/transaction.tsx), [ui/dialogs.tsx](../packages/snap/src/ui/dialogs.tsx)): the "Signing with" section already shows the signing address in a `Copyable`; with multiple accounts it must remain unambiguous. Add the account index next to it ("Account 2") so a user with several accounts sees which one a dapp selected via the `address` option. This is the key display-integrity requirement for multi-account: a dapp choosing the signing account must be visible.
- **Connect dialog**: unchanged in essence; it shows the active account being disclosed. Optionally note that the site sees the active account and can request a specific one.

## 6. Security and consent analysis

### 6.1 The subtree entropy grant already covers this

No manifest or permission change is needed: the `m/44'/148'` caveat already permits every index (the subtree was kept precisely because multi-account is a committed roadmap item). Deriving index 1..N uses the same audited permission and the same on-demand, never-persisted derivation as index 0.

### 6.2 The `address` option must resolve only to owned, revealed accounts

The single most important rule: `resolveSigningIndex` (§5.2) iterates only `state.accounts`. An origin cannot pass an arbitrary G-address and cause the wallet to derive-and-sign for a never-revealed index. This preserves the current guarantee that a user consciously controls which accounts exist, while still giving Freighter parity for accounts they have added. A non-owned `address` still returns SEP-43 `-3`, unchanged.

### 6.3 Active-account switching is wallet-global (accepted, matches network)

`setActiveAccount` changes what every connected origin sees on the next `getAddress`, exactly as `setNetwork` does for the network. This is a deliberate, disclosed trade-off (the switch is dialog-confirmed and wallet-scoped). A per-origin active account (each site remembers its own selection) is strictly more private and avoids cross-site coupling, but adds per-origin account state and more dialogs; it is deferred as a possible enhancement. For the first iteration, the per-request `address` option is the fine-grained control and the global active account is the default.

### 6.4 Cross-account privacy / correlation

Multiple accounts are often used precisely to _avoid_ linking activity. Two implications:

- `getAccounts` discloses all revealed addresses at once to a connected origin, which links them. That is inherent to an enumeration method and is why it requires a connection grant and returns only user-revealed accounts. A user who wants unlinkable accounts should not reveal them to the same origin; the home-page-only add flow (no `addAccount` RPC use) supports that. Document this in user-facing copy.
- The active-account model means a connected origin sees whichever account is active when it calls `getAddress`. Switching accounts to interact with a site the user wants kept separate is the user's control; the snap should not silently expose non-active accounts to an origin that only called `getAddress`.

### 6.5 Display integrity with account selection

When a dapp uses the `address` option to pick a non-active account, the dialog must show which account signs (§5.7). Otherwise a user could believe they are signing with account 1 (the active one) while a transaction is signed with account 2. The signing address is already shown; adding the account index makes the selection legible. This is the multi-account extension of the existing "what you see is what you sign" property.

### 6.6 No new key exposure

Keys for every index remain function-scoped in `deriveKeypair`, never persisted, never returned, never logged. State gains only integers (indices) and, if labels are added later, user-supplied strings, none of it secret. The "no key material in state" invariant in the threat model is unchanged.

## 7. Backwards compatibility

- An existing wallet migrates to `{ activeAccount: 0, accounts: [0] }`, so `getAddress`, signing, balances, and home page behave identically until the user adds an account.
- Single-account dapps that never pass `address`, or always pass account 0's address, are unaffected: the resolver returns the active account (0) or matches index 0.
- The connector types already expose `address?` on the signing options; adding `getAccounts` / `setActiveAccount` / `addAccount` is additive. Pin the connector's `DEFAULT_SNAP_VERSION` bump alongside the release.
- Because `accounts` starts as `[0]`, a dapp calling `getAccounts` on an un-migrated-by-use wallet sees exactly the one account it would have seen via `getAddress`.

## 8. Testing plan

- **Derivation vectors**: assert index 0 and index 1 addresses against the official SEP-5 vectors (both addresses already in the test fixtures); extend to index 2+.
- **Address resolution**: `signTransaction` with `address` = a revealed account signs with that index; with the active account's address signs active; with a non-owned address returns `-3`; with `undefined` signs active.
- **Add / switch**: `addAccount` reveals only the next contiguous index; `setActiveAccount` to a revealed index switches and is reflected by `getAddress`; switching to a non-revealed index is rejected.
- **Migration**: a version-1 state object upgrades to version 2 preserving `network`, `origins`, `tokens`, with `activeAccount: 0`, `accounts: [0]`; a corrupt object resets to version-2 defaults; a stray `activeAccount` not in `accounts` coerces to 0; an out-of-range index is rejected.
- **Display**: signing dialogs show the account index for the signing account; home page renders the account list, switch, and add controls; `onUserInput` handles the new buttons (mirroring the existing disconnect/remove-token handlers in [index.tsx](../packages/snap/src/index.tsx)).
- **State-lock concurrency**: `addAccount` and `setActiveAccount` run under the existing `withStateLock` mutex; concurrent add/switch do not drop writes.

## 9. Open questions and deferred items

1. **Per-origin active account** (§6.3): worth it for privacy, or is the global active + per-request `address` enough? Recommend deferring; revisit if users report cross-site coupling friction.
2. **Account labels/nicknames**: local display strings for accounts. Pure UX, no security weight; defer until copy stabilizes (same posture as the i18n deferral in [PLAN.md](PLAN.md)).
3. **`addAccount` RPC**: ship it, or make account creation home-page-only for the first iteration to keep the dapp surface minimal? Recommend home-page-only first (smaller attack surface, simpler consent story), add the RPC once a real dapp needs it.
4. **Gap discovery on restore**: if a user restores an SRP they previously used with, say, 5 accounts in Freighter, this snap starts at `accounts: [0]` and they must re-add 1..4. A bounded, user-initiated "scan for used accounts" (query Horizon for funded accounts across a gap-limited index window) could rediscover them. Deferred; note it as a known restore-UX gap, and keep it user-initiated and bounded if built (never an automatic or origin-triggered scan).
5. **Max account cap**: propose `MAX_ACCOUNT_INDEX = 256` as a state-validation bound. Confirm this is comfortably above real usage.

## 10. Suggested implementation phases

1. **State + derivation core**: version-2 schema, migration, `getAddressForIndex`, active-account resolution, `MAX_ACCOUNT_INDEX`. Keep RPC behavior identical (active = 0). Ship behind no user-visible change; pure groundwork with migration tests.
2. **Signing resolution**: switch `sign.tsx` from reject-on-mismatch to `resolveSigningIndex`; add the account index to signing dialogs. Freighter parity for the `address` option lands here.
3. **Home-page management**: account list, "Use" (switch active), "Add account", with `onUserInput` handlers and dialogs.
4. **RPC surface**: `getAccounts`, `setActiveAccount`, and (if kept) `addAccount`; connector methods and types; `DEFAULT_SNAP_VERSION` bump.
5. **Docs**: update [THREAT-MODEL.md](THREAT-MODEL.md) (active-account model, cross-account privacy note, `address`-resolution rule), the connector README, and this document's status to "implemented".

## 11. References

- SEP-0005 (key derivation, `m/44'/148'/x'`): https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
- SEP-0043 (wallet interface, the `address` option): https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
- Freighter dapp API (multi-account, "switch to that account if available"): https://docs.freighter.app
- Internal: [research/example-snaps-analysis.md](research/example-snaps-analysis.md) (MetaStellar / Sui / NEAR account models), [THREAT-MODEL.md](THREAT-MODEL.md) §5 (entropy-scope rationale), [PLAN.md](PLAN.md) open question 1.
