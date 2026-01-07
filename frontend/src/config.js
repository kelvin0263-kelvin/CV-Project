// Get the API base URL dynamically
const getBaseUrl = () => {
    // Check if we're in browser environment
    if (typeof window === 'undefined') {
        return "http://localhost:8000";
    }

    const hostname = window.location.hostname;
    console.log("=== API URL Detection ===");
    console.log("Current Hostname:", hostname);

    // 1. Manually set via Env Var
    if (import.meta?.env?.VITE_API_URL) {
        console.log("Using Env Var:", import.meta.env.VITE_API_URL);
        return import.meta.env.VITE_API_URL;
    }

    // 2. Auto-detect RunPod Environment
    if (hostname.includes('runpod.net') || hostname.includes('proxy.runpod')) {
        // RunPod URLs look like: tmz0ucc9qanav4-5173.proxy.runpod.net
        // We want to target:     tmz0ucc9qanav4-8000.proxy.runpod.net
        const newHost = hostname.replace(/-5173\./, '-8000.');
        const newUrl = `${window.location.protocol}//${newHost}`;
        console.log("✅ Detected RunPod! Target API:", newUrl);
        return newUrl;
    }

    // 3. Fallback to Localhost
    console.log("Using Localhost fallback");
    return "http://localhost:8000";
};

// Execute immediately and cache the result
let _cachedUrl = null;
const getApiUrl = () => {
    if (!_cachedUrl) {
        _cachedUrl = getBaseUrl();
    }
    return _cachedUrl;
};

// For backward compatibility, export the URL directly
// But compute it lazily when first accessed
const API_BASE_URL = getApiUrl();

// Export the base URL
export default API_BASE_URL;

// Also export the getter function in case dynamic access is needed
export { getApiUrl };

// Helper to get WebSocket URL
export const getWSUrl = (endpoint) => {
    const baseUrl = getApiUrl();
    const protocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host = baseUrl.replace(/^https?:\/\//, '');
    return `${protocol}://${host}${endpoint}`;
};
