// Dynamic API URL getter - must be called at runtime in browser
export const getApiBaseUrl = () => {
    // Check browser environment
    if (typeof window === 'undefined') {
        return "http://localhost:8000";
    }

    // Check for environment variable first
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) {
        return import.meta.env.VITE_API_URL;
    }

    const hostname = window.location.hostname;

    // Auto-detect RunPod
    if (hostname.includes('runpod')) {
        const newHost = hostname.replace(/-5173/, '-8000');
        return `${window.location.protocol}//${newHost}`;
    }

    return "http://localhost:8000";
};

// Helper to get WebSocket URL
export const getWSUrl = (endpoint) => {
    const baseUrl = getApiBaseUrl();
    const protocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host = baseUrl.replace(/^https?:\/\//, '');
    return `${protocol}://${host}${endpoint}`;
};

// For backward compatibility - but this is now a getter function
const API_BASE_URL = getApiBaseUrl();
export default API_BASE_URL;
