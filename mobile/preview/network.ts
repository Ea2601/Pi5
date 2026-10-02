// expo-network önizleme sahtesi: Wi-Fi
export const NetworkStateType = { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR', WIFI: 'WIFI', ETHERNET: 'ETHERNET', VPN: 'VPN' } as const;
export async function getNetworkStateAsync() { return { type: NetworkStateType.WIFI, isConnected: true, isInternetReachable: true }; }
