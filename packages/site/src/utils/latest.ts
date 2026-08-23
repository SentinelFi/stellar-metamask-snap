/**
 * Decides which of several overlapping asynchronous reads may write.
 *
 * The panels on this page are read as one wallet, and the send form builds
 * transactions from exactly the values they display. More than one read is in
 * flight in ordinary use: wallet state re-reads whenever the installed snap
 * changes and again after every action, and the history table re-reads on
 * every account and network change. Nothing orders their replies. Without a
 * rule, a slow read begun for one account or network lands after a later one
 * has already answered and wins simply by being last, leaving this account's
 * address beside the previous one's balances, or a table of one network's
 * transactions under another network's name and explorer links.
 *
 * The rule is that only the most recently started read may write. Each one
 * claims a turn before it begins and asks, at the moment it is about to
 * commit, whether it still holds it; a read that has been superseded drops its
 * result rather than writing it. That is the correct arm, because there is
 * nothing to reconcile: the newer read is asking the same question of a wallet
 * the older one no longer describes.
 *
 * {@link Latest.invalidate} is the other half, and the reason a plain counter
 * inside each caller is not enough. The context can change before the read
 * that replaces the outstanding one has started, and a reply landing in that
 * gap is exactly the one that would be rendered under the wrong wallet.
 * Disowning outstanding reads at the moment the context changes closes it.
 *
 * This is a display-integrity control and nothing more. The wallet decodes the
 * envelope it is given and enforces its own active account and network, so
 * what a stale read could produce is a misleading page and a transaction that
 * fails, never a signature the user did not approve.
 */
export type Latest = {
  /**
   * Claims the next turn.
   *
   * @returns A predicate that answers whether this claim is still current.
   */
  claim: () => () => boolean;
  /** Disowns every outstanding claim without making a new one. */
  invalidate: () => void;
};

/**
 * Creates a {@link Latest} tracker.
 *
 * @returns A tracker with no outstanding claims.
 */
export function latestOnly(): Latest {
  let issued = 0;
  return {
    claim: () => {
      issued += 1;
      const token = issued;
      return () => token === issued;
    },
    invalidate: () => {
      issued += 1;
    },
  };
}
