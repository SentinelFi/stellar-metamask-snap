import { Networks } from '@stellar/stellar-sdk/base';

/** Network identifiers, matching Freighter's naming. */
export type NetworkName = 'PUBLIC' | 'TESTNET' | 'FUTURENET';

export type NetworkConfig = {
  name: NetworkName;
  networkPassphrase: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
  friendbotUrl: string | null;
};

/**
 * Known networks. All endpoints verified to accept `Origin: null` requests
 * from the snap sandbox (Phase 0, Spike C).
 */
export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  PUBLIC: {
    name: 'PUBLIC',
    networkPassphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    friendbotUrl: null,
  },
  TESTNET: {
    name: 'TESTNET',
    networkPassphrase: Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  FUTURENET: {
    name: 'FUTURENET',
    networkPassphrase: Networks.FUTURENET,
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    sorobanRpcUrl: 'https://rpc-futurenet.stellar.org',
    friendbotUrl: 'https://friendbot-futurenet.stellar.org',
  },
};

export const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkName[];
