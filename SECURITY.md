# Security Policy

This project aims to become a MetaMask Snap that handles key derivation and transaction signing for the Stellar network. Security reports are taken seriously and are very much appreciated.

## Reporting a vulnerability

**If the issue is sensitive** — anything that could put user funds, keys, or privacy at risk (key derivation, signing, dialog display integrity, state handling, dependency compromise):

- **Do not open a public issue.**
- Report it privately via **GitHub private vulnerability reporting** ("Report a vulnerability" under the repository's Security tab).

**If the issue is not sensitive** (hardening suggestions, documentation gaps, best-practice deviations that cannot be exploited), feel free to open a **public GitHub issue**.

## Scope

- The snap source code, its key-derivation and signing logic, and its published npm packages (once released).
- The connector/dapp packages in this repository.
- Out of scope: the MetaMask platform itself (report to [MetaMask](https://github.com/MetaMask/snaps/security)), the Stellar protocol and its SDKs (report to the [Stellar Development Foundation](https://stellar.org)), and third-party RPC providers.

Thank you.
