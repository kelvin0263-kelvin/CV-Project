// Change this URL to your RunPod Public URL when deploying
// Example: "https://your-pod-id-8000.proxy.runpod.net"
// Or the public IP: "http://123.456.78.90:8000"

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Export the base URL
export default API_BASE_URL;

// Helper to get WebSocket URL
export const getWSUrl = (endpoint) => {
    // If API_BASE_URL is https, WS should be wss
    const protocol = API_BASE_URL.startsWith('https') ? 'wss' : 'ws';
    const host = API_BASE_URL.replace(/^https?:\/\//, '');
    return `${protocol}://${host}${endpoint}`;
};
