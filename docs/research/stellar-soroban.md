# Stellar + Soroban — Knowledge Base (Wallet Implementer's Perspective)

> Research snapshot: 2026-08-08. Sources: developers.stellar.org, stellar-protocol SEPs, js-stellar-sdk, Freighter docs.
> Purpose: everything the snap must know to derive keys, display, sign, and submit Stellar/Soroban transactions.

## 1. Fundamentals

### Accounts & keys
- **ed25519** keypairs. Strkey encodings: `G...` public key, `S...` secret seed, `C...` contract, `M...` muxed account, `T...` pre-auth tx signer, `X...` hash(x) signer, `P...` signed-payload signer.
- An account **exists only after being funded** (`createAccount` op or friendbot). A plain `payment` to a non-existent account fails — the wallet must detect this and use/offer `createAccount`.
- Account entry: balances, sequence number, subentry count, flags, home domain, thresholds, signers, liabilities.

### Reserves
- Base reserve **0.5 XLM**; minimum balance = **(2 + numSubentries) × 0.5 XLM** ⇒ 1 XLM for a bare account.
- Subentries (0.5 XLM each): trustlines (incl. LP shares), offers, extra signers, data entries. Cap 1,000/account.
- Sponsored reserves (`beginSponsoringFutureReserves`) let another account pay reserves — onboarding UX option.

### Sequence numbers
- Tx sequence = account sequence + 1. Wallet must fetch current sequence before building (Horizon `GET /accounts/{id}` or RPC `getLedgerEntries`; `rpc.Server.getAccount()` does the latter).

### Assets & trustlines
- Non-XLM assets = `(code, issuer G-address)`, alphanum4/12. Holding requires a **trustline** via `changeTrust` (0.5 XLM reserve; limit 0 deletes). Issuer flags: auth-required / auth-revocable / clawback.

### Amounts, memos
- 1 XLM = 10,000,000 **stroops** (7 decimals, int64 on-chain).
- Memos: `MEMO_TEXT` (≤28 bytes), `MEMO_ID` (uint64 — critical for exchange deposits), `MEMO_HASH`/`MEMO_RETURN` (32 bytes). **Soroban txs must use `MEMO_NONE`.**
- SEP-29: Horizon flags accounts with `config.memo_required` — warn before memo-less payments to them.

### Fees
- Base fee **100 stroops/operation**; the fee field is a *maximum bid* (surge pricing = clock auction; you usually pay less).
- Soroban: `fee = resource fee + inclusion fee`; resource fee split non-refundable (CPU, bandwidth) + refundable (rent, events, return value — unused refunded).
- **Fee-bump envelopes** (`ENVELOPE_TYPE_TX_FEE_BUMP`): wrap a signed inner tx with a new fee source; replacing a pending tx needs ≥10× bid. Wallets must be able to sign these.

### Networks (exact passphrases — cryptographically part of every signature)
| Network | Passphrase | Horizon | RPC |
|---|---|---|---|
| Mainnet | `Public Global Stellar Network ; September 2015` | ecosystem providers | ecosystem providers |
| Testnet | `Test SDF Network ; September 2015` | `https://horizon-testnet.stellar.org` | `https://soroban-testnet.stellar.org` |
| Futurenet | `Test SDF Future Network ; October 2022` | `https://horizon-futurenet.stellar.org` | `https://rpc-futurenet.stellar.org` |

- Friendbot: `https://friendbot.stellar.org?addr=G...` (10,000 XLM, testnet; futurenet variant exists). Testnet resets 2–4×/year (next: Dec 16, 2026).
- **SDF runs no public mainnet Horizon/RPC.** Mainnet providers: Gateway.fm (`https://soroban-rpc.mainnet.stellar.gateway.fm`), Ankr, OnFinality, Lightsail/Quasar, Blockdaemon/QuickNode/etc. (keyed). Freighter proxies mainnet via its own backend.

## 2. Key derivation — SEP-0005 (must replicate exactly)

1. BIP-39 mnemonic → 512-bit seed (in a snap: entropy comes from `snap_getBip32Entropy` instead).
2. **SLIP-0010 ed25519** (HMAC-SHA512, `"ed25519 seed"`), **hardened-only** segments.
3. Path **`m/44'/148'/x'`** — only 3 levels, no change/address_index. Coin type **148** (SLIP-0044 XLM).
4. 32-byte derived key = ed25519 seed → `Keypair.fromRawEd25519Seed(key)`.

**Conformance test vectors** (SEP-5):
- Mnemonic `illness spike retreat truth genius clock brain pass fit cave bargain toe`:
  - `m/44'/148'/0'` → `GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6` / `SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN`
  - `m/44'/148'/1'` → `GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX` / `SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS`

Note: MetaMask's `snap_getBip32Entropy` derives from the SRP the BIP-32/SLIP-10 way, which for ed25519 matches SLIP-0010 — deriving `m/44'/148'` in the manifest caveat and `x'` in-snap reproduces SEP-5 addresses for the same mnemonic. Validate against the vectors in unit tests (feed a known mnemonic via snaps-jest options if supported, or test the derivation function directly against SLIP-10 vectors).

### Strkey encoding (SEP-23)
`base32_no_padding(versionByte || payload || CRC16-XModem(versionByte || payload))`. Version bytes: G=`6<<3`, S=`18<<3`, M=`12<<3`, T=`19<<3`, X=`23<<3`, P=`15<<3`, C=`2<<3`. Decode: reject bad lengths (≡1,3,6 mod 8), nonzero trailing bits, padding, bad CRC, non-round-trips. (The SDK's `StrKey` class implements all this.)

## 3. Transactions (classic)

### Envelope (XDR)
`TransactionEnvelope` union: `ENVELOPE_TYPE_TX_V0` (legacy), `ENVELOPE_TYPE_TX` (v1), `ENVELOPE_TYPE_TX_FEE_BUMP`.
v1 = `{ tx, signatures: DecoratedSignature[] (max 20) }`; `tx` = `{ sourceAccount (muxed), fee (uint32 stroops), seqNum, cond (Preconditions: timeBounds/ledgerBounds/minSeqNum/minSeqAge/minSeqLedgerGap/extraSigners≤2), memo, operations (1–100; Soroban: exactly 1), ext (v1 → SorobanTransactionData) }`.
Transactions are **atomic** — one failed op fails all (fee still charged).

### Operations (26)
`createAccount`, `payment`, `pathPaymentStrictSend/Receive`, `manageBuyOffer`/`manageSellOffer`/`createPassiveSellOffer`, `setOptions` (flags/domain/weights/thresholds/signers), `changeTrust`, `allowTrust` (deprecated), `accountMerge` (deletes account!), `manageData` (≤64-byte name/value), `bumpSequence`, `createClaimableBalance`/`claimClaimableBalance`, `beginSponsoringFutureReserves`/`end.../revokeSponsorship`, `clawback`/`clawbackClaimableBalance`, `setTrustLineFlags`, `liquidityPoolDeposit/Withdraw`, **Soroban:** `invokeHostFunction`, `extendFootprintTTL`, `restoreFootprint`. Each op may override `sourceAccount`.

### Signing
```
payload  = networkId || envelopeType_XDR || tx_XDR      // networkId = SHA256(passphrase)
txHash   = SHA256(payload)                               // also the network tx ID (hex)
sig      = ed25519_sign(secret, txHash)                  // 64 bytes
DecoratedSignature = { hint: pubkey[28..32], sig }       // appended to envelope
```
= `Transaction.sign(keypair)` / `Transaction.hash()` in the SDK.

### Multisig / thresholds
- low/medium/high thresholds 0–255; master key weight default 1. Categories: low = allowTrust/setTrustLineFlags/bumpSequence/claimClaimableBalance; **medium = everything else incl. payment & invokeHostFunction**; high = accountMerge, setOptions changing signers/thresholds.
- Signature weights must sum ≥ threshold for each op's source. **Extra unneeded signatures fail the tx.**
- Multisig flow: sign → if weight insufficient, pass base64 XDR to co-signers (signatures append to same envelope).

## 4. Soroban

### Contracts
Wasm modules (Rust + soroban-sdk); addresses `C...`; values cross the boundary as `ScVal` XDR; interfaces ship as contract-spec entries in the Wasm (basis for typed TS bindings).

### invokeHostFunction
`{ hostFunction, auth: SorobanAuthorizationEntry[] }`; variants invoke-contract / upload-wasm / create-contract. Constraints: **exactly one Soroban op per tx, MEMO_NONE, no muxed source**. SDK helpers: `Operation.invokeContractFunction()` etc.

### Simulation → assembly lifecycle (mandatory)
1. Build tx with bare op (inclusion fee only).
2. RPC `simulateTransaction(txB64, { resourceConfig?, authMode? })` → `{ transactionData, minResourceFee, results[0].{xdr, auth[]}, events, restorePreamble?, latestLedger, error? }`.
3. `rpc.assembleTransaction(tx, sim)` or `server.prepareTransaction(tx)` — injects SorobanTransactionData, bumps fee, attaches auth entries.
4. Sign envelope (+ auth entries if address-credentialed) → `sendTransaction` → poll `getTransaction`.
- If `restorePreamble` present: submit a `restoreFootprint` tx first (it carries its own transactionData/minResourceFee), then re-simulate the real tx.

### Authorization entries — what `signAuthEntry` is for
`SorobanAuthorizationEntry = { credentials, rootInvocation }`.
- `SOROBAN_CREDENTIALS_SOURCE_ACCOUNT` — auth rides on the envelope signature; nothing extra.
- `SOROBAN_CREDENTIALS_ADDRESS` — `{ address, nonce, signatureExpirationLedger, signature: ScVal }`; needs a **separate signature** over:
```js
preimage = HashIdPreimage.envelopeTypeSorobanAuthorization({
  networkId, nonce, invocation: rootInvocation, signatureExpirationLedger })
payload  = SHA256(preimage.toXDR())
sig      = ed25519_sign(payload)   // embedded as ScVal vec of { public_key, signature } map
```
- `authorizeEntry` in the SDK accepts a Keypair **or an async callback** receiving the preimage — that callback shape is how wallets plug in.
- Host verifies sig, nonce uniqueness, and matches the signed invocation tree against actual `require_auth` calls. Smart-wallet contracts implement `__check_auth` instead.
- Wallet display duty: decode the **invocation tree** (contract, function, args) + expiration ledger.

### State archival / TTL
Storage classes: temporary (deleted at TTL 0), instance (shares contract TTL), persistent (archived, restorable — token balances live here). Since Protocol 23, simulation auto-lists archived entries for restore during InvokeHostFunction; explicit `restoreFootprint`/`extendFootprintTTL` remain for oversized cases. Wallet duty: honor `restorePreamble`.

## 5. Infrastructure

### Horizon (REST; history + classic)
`GET /accounts/{id}` (balances/sequence/signers/thresholds), `/accounts/{id}/payments|transactions|operations|effects` (SSE + cursor pagination), `POST /transactions` (sync submit, `tx=<b64>`), `POST /transactions_async`, `/order_book`, `/paths/strict-send|strict-receive`, `/fee_stats`, `/assets`, `/claimable_balances`.

### Stellar RPC (JSON-RPC 2.0; handles ALL txs, not just Soroban)
`getEvents`, `getFeeStats`, `getHealth`, `getLatestLedger`, `getLedgerEntries`, `getLedgers`, `getNetwork`, `getTransaction`, `getTransactions`, `getVersionInfo`, `sendTransaction`, `simulateTransaction`. No `getAccount` method — `rpc.Server.getAccount()` synthesizes via `getLedgerEntries`.
- `sendTransaction` → `{ status: PENDING|DUPLICATE|TRY_AGAIN_LATER|ERROR, hash, ... }`; poll `getTransaction(hash)` → `NOT_FOUND|SUCCESS|FAILED`.

## 6. JS tooling

### @stellar/stellar-sdk (v16+: stellar-base folded in — don't install separately)
- Namespaces: `Horizon` (`Horizon.Server`), `rpc` (`rpc.Server`, `assembleTransaction`), `contract` (`contract.Client`, `AssembledTransaction` with `signAuthEntries`), primitives (`TransactionBuilder`, `Transaction`, `FeeBumpTransaction`, `Keypair`, `Asset`, `Memo`, `Networks`, `StrKey`, `xdr`, `nativeToScVal`, `scValToNative`, `authorizeEntry`, `TimeoutInfinite`, `BASE_FEE`).
- **`@stellar/stellar-sdk/base` subpath = offline-only primitives** (StrKey, Keypair, TransactionBuilder, xdr) without networking code — ideal for a minimal snap bundle if network calls stay outside. Native fetch, no axios; pure-JS crypto in browser builds (no native deps) — should bundle for SES, but verify with `mm-snap eval` early.

```js
import { rpc, TransactionBuilder, Networks, Operation, BASE_FEE } from "@stellar/stellar-sdk";
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const account = await server.getAccount(pubKey);
let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.invokeContractFunction({ contract, function: "transfer", args }))
  .setTimeout(60).build();
tx = await server.prepareTransaction(tx);   // simulate + assemble
tx.sign(keypair);
const send = await server.sendTransaction(tx);  // then poll getTransaction(send.hash)
```

### Others
- `@stellar/typescript-wallet-sdk` — anchor flows (SEP-10/24/30), key management, soroban helpers; for wallet *products*, not needed for the core snap.
- `stellar-hd-wallet` (chatch) — community SEP-5 implementation; fine as reference/test oracle, questionable as runtime dep. In-snap: SLIP10Node from `@metamask/key-tree` + `Keypair.fromRawEd25519Seed` is cleaner.

## 7. Wallet interop standards

### SEP-0043 — Standard Web Wallet API (the interface to implement)
All methods return `{...result} & { error?: { message, code, ext? } }`; codes: −1 internal, −2 external service, −3 bad request, **−4 user rejected**.
```typescript
getAddress(): Promise<{ address: string }>
signTransaction(xdr, opts?: { networkPassphrase?, address?, submit?, submitUrl? })
  : Promise<{ signedTxXdr: string; signerAddress: string }>
signAuthEntry(authEntry, opts?: { networkPassphrase?, address? })
  : Promise<{ signedAuthEntry: string; signerAddress: string }>
signMessage(message, opts?: { networkPassphrase?, address? })
  : Promise<{ signedMessage: string; signerAddress: string }>
getNetwork(): Promise<{ network: string; networkPassphrase: string }>
```

### Stellar Wallets Kit (Creit-Tech) — the aggregator dapps actually use
Supports xBull, Albedo, Freighter, Rabet, WalletConnect, Lobstr, Hana, HOT, Klever (+ hardware modules). A new wallet integrates by shipping a **module implementing the kit's ModuleInterface** (id/name/icon, availability check, SEP-43 methods). For the snap: a module that maps kit calls → `wallet_invokeSnap`.

### Freighter API (de-facto standard to mirror; @stellar/freighter-api)
`isConnected`, `isAllowed`/`setAllowed` (per-origin allowlist), `requestAccess` → `{address}`, `getAddress` (silent, empty if not allowed), `getNetwork` → `{ network: "PUBLIC"|"TESTNET"|"FUTURENET"|"STANDALONE", networkPassphrase }`, `getNetworkDetails` (+ networkUrl, sorobanRpcUrl), `signTransaction(xdr, { network?, networkPassphrase?, address? })` (warns on network mismatch), `signAuthEntry`, `signMessage` (SEP-53), `addToken({ contractId })`, `WatchWalletChanges` (polling). Rejection message: `"The user rejected this request."`

### SEP-0007 — `web+stellar:` URI scheme
`tx` op (full XDR + `callback`, `origin_domain`, `signature`, ...) and `pay` op (destination/amount/asset/memo). Wallet duties: verify `signature` against `URI_REQUEST_SIGNING_KEY` in origin_domain's stellar.toml; full display; never auto-sign; POST to `callback` if present else submit. (Later feature, not MVP.)

### SEP-0010 — Web Authentication
Challenge tx with **sequence 0** (unrunnable), 15-min timebounds, ManageData ops carrying nonce. Wallet must willingly sign seq-0 transactions (with clear "authentication" framing). Returns JWT; powers anchor logins.

### SEP-0053 — Message signing
`payload = SHA256("Stellar Signed Message:\n" + messageBytes)` → ed25519 sign → 64-byte sig (base64; SEP-43 says hex — normalize deliberately). Test vector: seed `SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW`, msg `Hello, World!` → `fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==`.

## 8. The three signing payloads (summary)

| Kind | Input | Payload signed | Output |
|---|---|---|---|
| Transaction | b64 `TransactionEnvelope` | `SHA256(SHA256(passphrase) ‖ envType ‖ tx)` | envelope + `DecoratedSignature`, re-serialized b64 |
| Soroban auth entry | b64 `SorobanAuthorizationEntry` / preimage | `SHA256(HashIdPreimage(sorobanAuth).toXDR())` | signed entry b64 |
| SEP-53 message | string/bytes | `SHA256("Stellar Signed Message:\n" + msg)` | 64-byte sig |

**Never sign raw dapp-supplied hashes** — always reconstruct the preimage from parseable XDR. The XDR is the source of truth for display; never trust dapp-provided summaries.

## 9. Existing wallets (API reference points)

- **Freighter** — extension, full SEP-43 + extras (above). The compatibility target.
- **xBull** — bridge model (`xBullWalletConnect`), falls back to webapp when extension absent.
- **LOBSTR** — extension relays signing to mobile app; only `isConnected`/`getPublicKey`/`signTransaction` ⇒ limited Soroban support.

## Must-support checklist for the snap

- [ ] SEP-5 derivation `m/44'/148'/x'` passing official test vectors
- [ ] Sign: classic txs, **seq-0 SEP-10 challenges** (flagged as auth in UI), fee-bump envelopes, Soroban txs (single op, MEMO_NONE), address-credential auth entries, SEP-53 messages
- [ ] Parse & display XDR (ops, amounts, memo, fees, invocation trees) — XDR is the only source of truth
- [ ] Sequence fetch + simulation via RPC; honor `restorePreamble`
- [ ] Network passphrase pinning per network; mismatch warnings
- [ ] createAccount vs payment detection for unfunded destinations; friendbot on testnet
- [ ] SEP-29 memo-required warning
