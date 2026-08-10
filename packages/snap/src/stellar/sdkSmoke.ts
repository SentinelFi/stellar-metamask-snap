import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

/**
 * Phase 0 / Spike A reference: exercises the signing-critical parts of
 * `@stellar/stellar-sdk` inside the SES sandbox — keypair construction,
 * strkey round-trips, transaction building, ed25519 signing, signature
 * verification, and XDR (de)serialization.
 *
 * Kept for reference and as a diagnostic; NOT wired into the RPC surface
 * since Phase 1 (nothing imports it, so it is excluded from the bundle).
 * Results from the real extension are recorded in docs/PHASE-0.md.
 *
 * @returns A summary of each check so snaps-jest can assert on it.
 */
export function runSdkSmoke() {
  // Keypair from a fixed raw seed + strkey round-trip.
  const seed = Buffer.alloc(32, 7);
  const keypair = Keypair.fromRawEd25519Seed(seed);
  const address = keypair.publicKey();
  const strKeyRoundTrip =
    StrKey.isValidEd25519PublicKey(address) &&
    StrKey.encodeEd25519PublicKey(StrKey.decodeEd25519PublicKey(address)) ===
      address;

  // Build a classic payment transaction and sign it.
  const source = new Account(address, '0');
  const transaction = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: address,
        asset: Asset.native(),
        amount: '1.2345678',
      }),
    )
    .addMemo(Memo.text('phase-0 spike'))
    .setTimeout(300)
    .build();

  transaction.sign(keypair);
  const [decoratedSignature] = transaction.signatures;
  if (!decoratedSignature) {
    throw new Error('Transaction was not signed.');
  }
  const signatureValid = keypair.verify(
    transaction.hash(),
    decoratedSignature.signature(),
  );

  // Serialize to XDR and parse it back (what signTransaction will do).
  const envelopeXdr = transaction.toXDR();
  const parsed = TransactionBuilder.fromXDR(envelopeXdr, Networks.TESTNET);
  const parsedEnvelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  const parsedMemo = 'memo' in parsed ? parsed.memo.value?.toString() : null;

  return {
    address,
    strKeyRoundTrip,
    signatureValid,
    txHash: transaction.hash().toString('hex'),
    xdrRoundTrip: parsed.toXDR() === envelopeXdr,
    envelopeType: parsedEnvelope.switch().name,
    memo: parsedMemo ?? null,
  };
}
