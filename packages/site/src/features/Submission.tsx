import type { NetworkName } from 'stellar-soroban-snap-connector';

import { Stack } from '../components/Layout';
import { Alert, AddressChip, ExternalLink } from '../components/Status';
import { explorerTxUrl } from '../utils';

/** What a completed sign-and-submit left behind. */
export type Submission = {
  /** Present once the network assigned the transaction a hash. */
  hash?: string | undefined;
  /** Soroban RPC acceptance status, when the path went through the RPC. */
  status?: string | undefined;
  /** Advisory safety warnings the wallet surfaced with the signature. */
  warnings?: string[] | undefined;
};

export type SubmissionResultProps = {
  submission: Submission | null;
  network: NetworkName | null;
  onDismiss: () => void;
};

/**
 * Renders the outcome of a submitted transaction.
 *
 * Two things are deliberately said rather than implied. The wallet's advisory
 * warnings are repeated here, because they are shown once inside a dialog the
 * user has already dismissed by the time they read this. And acceptance is
 * described as acceptance, not as settlement: a hash means the network took
 * the envelope, and the history table below is where it either appears or
 * does not.
 *
 * @param props - Result props.
 * @param props.submission - The completed submission, or null.
 * @param props.network - The active network, for the explorer link.
 * @param props.onDismiss - Clears the result.
 * @returns The result block, or null when there is nothing to report.
 */
export const SubmissionResult = ({
  submission,
  network,
  onDismiss,
}: SubmissionResultProps) => {
  if (!submission) {
    return null;
  }

  const explorer =
    network && submission.hash ? explorerTxUrl(network, submission.hash) : null;

  return (
    <Stack gap="0.8rem">
      {submission.warnings?.length ? (
        <Alert tone="warning" title="The wallet flagged this transaction:">
          {submission.warnings.join(' ')}
        </Alert>
      ) : null}
      <Alert tone="success" title="Submitted." onDismiss={onDismiss}>
        {submission.hash ? (
          <>
            {'The network accepted the transaction '}
            <AddressChip value={submission.hash} keep={8} />
            {submission.status ? ` (status ${submission.status})` : ''}
            {explorer ? (
              <>
                {' '}
                <ExternalLink href={explorer}>View on explorer</ExternalLink>
              </>
            ) : null}
            {'. It appears in the history below once the ledger closes.'}
          </>
        ) : (
          'The transaction was signed, but the network returned no hash.'
        )}
      </Alert>
    </Stack>
  );
};
