import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Activity, Lock, User } from 'lucide-react';
import { getApiBaseUrl } from '../apiConfig';

const Login = ({ onLogin }) => {
    const apiUrl = getApiBaseUrl();
    const navigate = useNavigate();
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [backendOk, setBackendOk] = useState(null);

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        fetch(`${apiUrl}/api/health`, { signal: controller.signal })
            .then((response) => response.json())
            .then((data) => {
                if (!cancelled && data?.ok) {
                    setBackendOk(true);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setBackendOk(false);
                }
            })
            .finally(() => {
                clearTimeout(timeoutId);
            });

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [apiUrl]);

    const canSubmit = backendOk === true && !loading;

    const handleSubmit = async (event) => {
        event.preventDefault();
        setError('');
        setLoading(true);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const trimmedIdentifier = identifier.trim();
        const body = trimmedIdentifier.includes('@')
            ? { email: trimmedIdentifier, password }
            : { username: trimmedIdentifier, password };

        try {
            const response = await fetch(`${apiUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const message = Array.isArray(data.detail)
                    ? data.detail.map((item) => item.msg || item.message).join(', ')
                    : (data.detail || 'Invalid credentials.');
                setError(message);
                return;
            }
            if (!data.access_token || !data.user) {
                setError('Invalid response from server.');
                return;
            }

            onLogin(data.access_token, data.user);
            navigate('/');
        } catch (err) {
            if (err.name === 'AbortError') {
                setError('Login timed out. Confirm the backend is running on port 8000.');
            } else {
                setError('Unable to connect to the backend. Start the backend service first.');
            }
        } finally {
            clearTimeout(timeoutId);
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-muted/20">
            <div className="w-full max-w-md p-4 space-y-6">
                <div className="flex flex-col items-center space-y-2 text-center">
                    <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                        <Activity className="h-6 w-6 text-primary" />
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight">Entrance Analysis System</h1>
                    <p className="text-sm text-muted-foreground">Enter your credentials to access the dashboard</p>
                </div>

                {backendOk === false && (
                    <div className="rounded-md bg-destructive/15 text-destructive px-4 py-2 text-sm text-center">
                        Unable to reach the backend. Start it with:
                        <br />
                        <code className="bg-muted px-1">python -m uvicorn main:app --host 0.0.0.0 --port 8000</code>
                    </div>
                )}

                <Card>
                    <CardHeader>
                        <CardTitle>Sign In</CardTitle>
                        <CardDescription>Sign in with your account</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Username or Email</label>
                                <div className="relative">
                                    <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                    <input
                                        type="text"
                                        autoComplete="username"
                                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pl-9"
                                        placeholder="Enter your username or email"
                                        value={identifier}
                                        onChange={(event) => setIdentifier(event.target.value)}
                                        required
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium">Password</label>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                    <input
                                        type="password"
                                        autoComplete="current-password"
                                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pl-9"
                                        placeholder="Enter your password"
                                        value={password}
                                        onChange={(event) => setPassword(event.target.value)}
                                        required
                                    />
                                </div>
                            </div>

                            {error && (
                                <div className="text-sm text-destructive text-center">
                                    {error}
                                </div>
                            )}

                            <Button type="submit" className="w-full" disabled={!canSubmit}>
                                {loading ? 'Signing in...' : backendOk === true ? 'Sign In' : 'Checking backend...'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
};

export default Login;
