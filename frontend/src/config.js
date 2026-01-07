const getBaseUrl = () => {
    // 1. Manually set via Env Var
    if (import.meta && import.meta.env && import.meta.env.VITE_API_URL) {
        return import.meta.env.VITE_API_URL;
    }

    // 2. Auto-detect RunPod Environment
    if (typeof window !== 'undefined' && window.location.hostname.includes('runpod.net')) {
        const port = window.location.port; // Might be empty if proxied via 80/443
        const host = window.location.hostname;

        // RunPod URLs usually look like: id-5173.proxy.runpod.net
        // We want to target:             id-8000.proxy.runpod.net
        if (host.includes('-5173')) {
            return `${window.location.protocol}//${host.replace('-5173', '-8000')}`;
        }
    }

    // 3. Fallback to Localhost
    return "http://localhost:8000";
};

const API_BASE_URL = getBaseUrl();

// Export the base URL
export default API_BASE_URL;

// Helper to get WebSocket URL
export const getWSUrl = (endpoint) => {
    // If API_BASE_URL is https, WS should be wss
    const protocol = API_BASE_URL.startsWith('https') ? 'wss' : 'ws';
    const host = API_BASE_URL.replace(/^https?:\/\//, '');
    return `${protocol}://${host}${endpoint}`;
};
