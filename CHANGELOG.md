# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

One changelog covers the whole repository: `stellar-soroban-snap` and `stellar-soroban-snap-connector` are versioned and released together, because the connector pins the exact snap version it installs. Release steps are in [docs/RELEASE.md](docs/RELEASE.md).

## [Unreleased]

Nothing has been published to npm yet, so every change below is still unreleased. On the first release these entries move under a `[0.1.0]` heading, dated, and the audited commit is recorded there.

### Added

- SEP-0005 key derivation at `m/44'/148'/x'` (ed25519) from the MetaMask Secret Recovery Phrase, conformance-tested against the official SEP-0005 vectors, so the same phrase yields the same addresses as Freighter, Ledger, and Lobstr.
- SEP-0043 dapp API with Freighter-compatible semantics: `requestAccess`, `getAddress`, `getNetwork`, `getNetworkDetails`, `setNetwork`, `signTransaction`, `signAuthEntry`, `signMessage`.
- Transaction review dialogs decoded from the transaction XDR itself rather than from dapp-supplied summaries, with the raw XDR always available alongside.
- Soroban support: in-snap display-verification simulation (resource fee, required auth signers, restore requirements), decoded contract invocations, and standalone authorization-entry signing.
- Advisory pre-signing safety checks for classic transactions: unfunded destination, SEP-0029 memo-required, and multisig weight.
- Multiple accounts: an explicit registry of user-revealed SEP-0005 indices, added and switched from the snap home page, with `getAccounts` and `setActiveAccount` for connected dapps and per-request account selection through the SEP-0043 `address` option.
- Soroban token tracking (`addToken`, `getBalances`) with contract-reported metadata read via read-only simulation.
- Snap home page showing network, active account, addresses, balances, tracked tokens, and connected sites, with per-origin disconnect and token removal.
- Companion packages: `stellar-soroban-snap-connector` (typed SEP-0043 client, drop-in `@stellar/freighter-api` facade, Stellar Wallets Kit module) and a Gatsby test-bench dapp.
- Property tests over the decoders and the transaction dialog, asserting that no input throws unhandled, that rendered inline text carries no hidden characters, and that every rendering limit sets the flag the signing paths fail closed on.
- Version-consistency check (`yarn check:versions`) run in CI, covering the four files that carry the release version.

### Security

- Fail-closed review: signing is refused for operation types, host functions, credential variants, and ScVal variants the snap cannot display faithfully, and for any value too large or deeply nested to render in full.
- Account selection requires a standing connection grant, so an origin without one cannot use resolution outcomes to test which addresses the wallet holds.
- Network passphrase pinned into every signature; a mismatching dapp-supplied passphrase is rejected.
- Dialog text sanitized against control, bidi, and zero-width characters, with an explicit warning when a rendered field differed from the signed bytes.
- Persisted state validated against a schema on every read, with prototype-chain-safe origin keys and a bounded account registry.
- State mutations serialized so concurrent read-modify-write sequences cannot drop a writer's change.
- Per-origin cooldown after repeated rejected dialogs.
- Horizon and Stellar RPC responses schema-validated, with redirects refused, bounded response bodies, and no insecure randomness in the shipped bundle (enforced in CI).
- The Soroban footprint (the signed state-access scope and resource commitment) is rendered in every Soroban review dialog, ordinary and fee-bump alike, with trustline keys naming their asset; signing fails closed when the footprint is absent, truncated, undecodable, or contains an unknown key variant.
- The companion site verifies the installed snap version against the release it was built for before enabling any controls, offers an exact-version update when they differ, and passes the pinned version to the connector; the release build also cross-checks `GATSBY_SNAP_VERSION` against the snap package version.
- Oversized declared response bodies are released before the error is raised, and the no-stream fallback counts real bytes via `arrayBuffer` instead of UTF-16 code units.
- Persisted token registries are normalized at the parse boundary (per-network cap, contract-ID and metadata validation, duplicate removal); `fund` and `getBalances` are rate limited per origin, identical balance lookups are coalesced through a short-lived cache, and every request counts against a per-origin in-flight budget.
- Classic safety checks cover account-merge destinations, every effective operation source, and the operation-appropriate signature threshold (high for account merge and signer changes), and disclose when the lookup budget forced any account to be skipped.
- Every explicit `address` selection requires a connection grant, including the active account, so an unconnected origin can no longer probe whether a guessed address is the active one; cold signing without an address is unchanged.
- Signed messages and `manageData` keys with hidden characters get an escaped, lossless exact view, and endpoint-derived simulation and RPC error text is sanitized before reaching dialogs.
- When an origin is too long to display in full, consent dialogs and the home page show the complete origin in a copyable field with a warning, since two long origins can otherwise truncate identically.
- Submission responses are accepted only when the returned transaction hash matches the locally computed hash of the exact signed envelope.
- RPC dispatch resolves handlers as own properties only, so names like `constructor` cannot resolve inherited JavaScript properties.
- Release provenance procedure documented in `docs/RELEASE.md`: publish from the annotated tag, treat the audited ID and version as protected inputs, verify the published tarball against a rebuild, retain an attestation.

[unreleased]: https://github.com/jeffnuclear/stelllar-metamask-snap/commits/main
