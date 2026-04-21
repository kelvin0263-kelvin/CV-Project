const AUTH_CHANGE_EVENT = 'app-auth-change';
const FETCH_INTERCEPTOR_FLAG = '__appAuthFetchInstalled';

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
    const wsUrl = new URL(`${protocol}://${host}${endpoint}`);
    const token = getStoredToken();
    if (token && !wsUrl.searchParams.has('token')) {
        wsUrl.searchParams.set('token', token);
    }
    return wsUrl.toString();
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

const resolveRequestUrl = (input) => {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const rawValue = input instanceof Request ? input.url : String(input ?? '');
        return new URL(rawValue, window.location.origin);
    } catch {
        return null;
    }
};

const isApiRequest = (url) => {
    if (!url) {
        return false;
    }

    const apiBaseUrl = getApiBaseUrl();
    const apiOrigin = (() => {
        try {
            return new URL(apiBaseUrl, window.location.origin).origin;
        } catch {
            return window.location.origin;
        }
    })();

    return url.pathname.startsWith('/api/') && url.origin === apiOrigin;
};

const isPublicApiRequest = (url) => {
    if (!url) {
        return false;
    }

    return url.pathname === '/api/auth/login' || url.pathname === '/api/health';
};

const withAuthorizationHeader = (headers, token) => {
    const nextHeaders = new Headers(headers || undefined);
    if (token && !nextHeaders.has('Authorization')) {
        nextHeaders.set('Authorization', `Bearer ${token}`);
    }
    return nextHeaders;
};

export const installAuthFetchInterceptor = () => {
    if (typeof window === 'undefined' || window[FETCH_INTERCEPTOR_FLAG]) {
        return;
    }

    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input, init = undefined) => {
        const requestUrl = resolveRequestUrl(input);
        const shouldAttachAuth = isApiRequest(requestUrl) && !isPublicApiRequest(requestUrl);
        let nextInput = input;
        let nextInit = init;

        if (shouldAttachAuth) {
            const token = getStoredToken();
            const headers = withAuthorizationHeader(
                input instanceof Request ? input.headers : init?.headers,
                token,
            );

            if (input instanceof Request) {
                nextInput = new Request(input, { headers });
            } else {
                nextInit = {
                    ...(init || {}),
                    headers,
                };
            }
        }

        const response = await originalFetch(nextInput, nextInit);
        if (shouldAttachAuth && response.status === 401) {
            clearAuthSession();
        }
        return response;
    };

    window[FETCH_INTERCEPTOR_FLAG] = true;
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
