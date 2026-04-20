const AUTH_CHANGE_EVENT = 'app-auth-change';

const normalizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

// Dynamic API URL getter - must be called at runtime in browser
export const getApiBaseUrl = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) {
        return normalizeBaseUrl(import.meta.env.VITE_API_URL);
    }

    if (typeof window !== 'undefined') {
        return normalizeBaseUrl(window.location.origin);
    }

    return 'http://localhost:8000';
};

export const getWSUrl = (endpoint) => {
    const configuredWsBase = (
        typeof import.meta !== 'undefined' &&
        import.meta.env &&
        import.meta.env.VITE_WS_URL
    )
        ? normalizeBaseUrl(import.meta.env.VITE_WS_URL)
        : null;
    const baseUrl = configuredWsBase || getApiBaseUrl();
    const protocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host = baseUrl.replace(/^https?:\/\//, '');
    return `${protocol}://${host}${endpoint}`;
};

const emitAuthChange = () => {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
    }
};

export const getStoredToken = () => {
    if (typeof window === 'undefined') {
        return null;
    }
    return window.localStorage.getItem('token');
};

export const getStoredUser = () => {
    if (typeof window === 'undefined') {
        return null;
    }

    const raw = window.localStorage.getItem('user');
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

export const storeAuthSession = (token, user) => {
    if (typeof window === 'undefined') {
        return;
    }

    if (token) {
        window.localStorage.setItem('token', token);
        window.localStorage.setItem('isAuthenticated', 'true');
    }

    if (user) {
        window.localStorage.setItem('user', JSON.stringify(user));
    } else {
        window.localStorage.removeItem('user');
    }

    emitAuthChange();
};

export const updateStoredUser = (user) => {
    if (typeof window === 'undefined') {
        return;
    }

    if (user) {
        window.localStorage.setItem('user', JSON.stringify(user));
    } else {
        window.localStorage.removeItem('user');
    }

    emitAuthChange();
};

export const clearAuthSession = () => {
    if (typeof window === 'undefined') {
        return;
    }

    window.localStorage.removeItem('token');
    window.localStorage.removeItem('user');
    window.localStorage.removeItem('isAuthenticated');
    emitAuthChange();
};

export const getAuthHeaders = (extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    const token = getStoredToken();

    if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    return headers;
};

export const subscribeAuthChanges = (callback) => {
    if (typeof window === 'undefined') {
        return () => {};
    }

    window.addEventListener(AUTH_CHANGE_EVENT, callback);
    window.addEventListener('storage', callback);

    return () => {
        window.removeEventListener(AUTH_CHANGE_EVENT, callback);
        window.removeEventListener('storage', callback);
    };
};

const API_BASE_URL = getApiBaseUrl();
export default API_BASE_URL;
