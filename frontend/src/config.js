const getBaseUrl = () => {
    // Debug Log
    console.log("Detecting API URL...");
    console.log("Current Hostname:", window.location.hostname);

    // 1. Manually set via Env Var
    if (import.meta && import.meta.env && import.meta.env.VITE_API_URL) {
        console.log("Using Env Var:", import.meta.env.VITE_API_URL);
        return import.meta.env.VITE_API_URL;
    }

    // 2. Auto-detect RunPod Environment
    if (typeof window !== 'undefined' && window.location.hostname.includes('runpod.net')) {
        const host = window.location.hostname;

        // RunPod URLs usually look like: id-5173.proxy.runpod.net
        // We want to target:             id-8000.proxy.runpod.net
        if (host.includes('-5173')) {
            const newHost = host.replace('-5173', '-8000');
            const newUrl = `${window.location.protocol}//${newHost}`;
            console.log("Detected RunPod Environment. Target API:", newUrl);
            return newUrl;
        }
    }

    // 3. Fallback to Localhost
    console.log("Fallback to Localhost");
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
