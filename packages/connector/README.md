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

Errors throw `StellarSnapError { message, code }` with SEP-0043 codes (`-1` internal, `-2` external service, `-3` invalid request, `-4` user rejected).

During snap development pass `{ snapId: 'local:http://localhost:8080' }`.

## 2. Freighter-compatible facade

Same method names and `{ ...result, error? }` convention as `@stellar/freighter-api` — a near drop-in swap:

```ts
import { createFreighterApi } from 'stellar-soroban-snap-connector';

const freighter = createFreighterApi();
const { address, error } = await freighter.requestAccess();
const { signedTxXdr } = await freighter.signTransaction(xdr);
```

Includes a polling `WatchWalletChanges` helper.

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
