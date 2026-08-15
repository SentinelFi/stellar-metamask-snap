# stellar-soroban-snap-connector

Dapp connector for the [Stellar Soroban MetaMask Snap](https://www.npmjs.com/package/stellar-soroban-snap): a typed **SEP-0043** client, a drop-in **`@stellar/freighter-api`-compatible facade**, and a **Stellar Wallets Kit** module. Zero runtime dependencies.

> Independent software, not affiliated with or endorsed by the Stellar Development Foundation.

## Install

```bash
npm install stellar-soroban-snap-connector
```

## 1. Typed client (`StellarSnap`)

```ts
import { StellarSnap, StellarSnapError } from 'stellar-soroban-snap-connector';

const snap = new StellarSnap(); // auto-detects MetaMask via EIP-6963

if (await snap.isAvailable()) {
  const { address } = await snap.connect(); // installs the snap + requests access

  const { signedTxXdr, signerAddress } = await snap.signTransaction(xdr, {
    networkPassphrase: 'Test SDF Network ; September 2015',
  });

  const { signedAuthEntry } = await snap.signAuthEntry(entryXdr); // Soroban auth
  const { signedMessage } = await snap.signMessage('hello'); // SEP-53
}
```

Errors throw `StellarSnapError { message, code }` with SEP-0043 codes (`-1` internal, `-2` external service, `-3` invalid request, `-4` user rejected). Every typed method validates the response shape at runtime before returning it, and `connect()`/`isInstalled()` verify that the snap version MetaMask actually installed matches the pinned release.

During snap development pass `{ snapId: 'local:http://localhost:8080' }`. The `version` option must be an exact `x.y.z` semver and `snapId` an `npm:`/`local:` ID; anything else is rejected at construction, because a range or arbitrary ID would silently defeat the audited-release pin.

### Multiple accounts

The wallet can hold several SEP-0005 accounts (`m/44'/148'/x'`), added by the user from the snap home page. A connected dapp can enumerate them, switch the wallet-global active account (dialog-confirmed), and target any revealed account per request via the SEP-43 `address` option:

```ts
const { accounts, activeIndex } = await snap.getAccounts();
// [{ index: 0, address: 'G...' }, { index: 1, address: 'G...' }]

await snap.setActiveAccount(1); // user confirms; every site sees the switch

// Or select a signing account per request, without switching:
await snap.signTransaction(xdr, { address: accounts[1].address });
```

Requesting an address the wallet does not hold returns `-3`.

### Reading balances

`getBalances()` returns the account's classic Horizon balances plus any Soroban tokens the user tracks, in one array. Branch on `type`, never on the `asset` string:

```ts
const { balances } = await snap.getBalances();

const xlm = balances.find((line) => line.type === 'native')?.balance ?? '0';
const tokens = balances.filter((line) => line.type === 'soroban');
// tokens[0].contractId identifies the contract; tokens[0].asset is display only
```

`asset` is a display string: `XLM` for the native asset, `CODE:ISSUER` for a classic asset, and `SYMBOL:CONTRACT_ID` for a tracked token. The last two are the same shape, and a token's symbol is reported by its contract, so a contract the user was persuaded to track can call itself `USDC`. Code that splits `asset` on `:` and shows the first field will display exactly that. `type` and `contractId` are what make the distinction available without parsing.

`tokensUnavailable: true` means the wallet's global token-read budget was exhausted and the token rows are missing, not that the account holds none of them. The classic balances are complete either way.

## 2. Freighter-compatible facade

Same method names and `{ ...result, error? }` convention as `@stellar/freighter-api` — a near drop-in swap:

```ts
import { createFreighterApi } from 'stellar-soroban-snap-connector';

const freighter = createFreighterApi();
const { address, error } = await freighter.requestAccess();
const { signedTxXdr } = await freighter.signTransaction(xdr);
```

Includes a polling `WatchWalletChanges` helper.

On failure the result fields stay empty, exactly like `@stellar/freighter-api`. When a post-approval submission fails after the user already signed, the signed envelope and status are preserved under `error.recovery` (`{ signedTxXdr, signerAddress, hash, status }`) — an explicit opt-in, so code that checks `if (signedTxXdr)` never submits an envelope from a call that reported an error.

## 3. Stellar Wallets Kit module

```ts
import {
  StellarWalletsKit,
  defaultModules,
} from '@creit.tech/stellar-wallets-kit';
import { StellarSnapKitModule } from 'stellar-soroban-snap-connector';

const kit = new StellarWalletsKit({
  modules: [...defaultModules(), new StellarSnapKitModule()],
  // ...your kit config
});
```

"MetaMask (Stellar Snap)" then appears in the kit's wallet picker with no further integration work.

## Repository

Source and documentation: [github.com/jeffnuclear/stelllar-metamask-snap](https://github.com/jeffnuclear/stelllar-metamask-snap) (Apache-2.0).
