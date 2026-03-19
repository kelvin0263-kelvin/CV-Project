import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { LayoutDashboard, Users, Shirt, Activity, BarChart3, Settings, Bell, LogOut, ArrowDownCircle, AlertTriangle, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { getApiBaseUrl, getStoredUser } from '../apiConfig';
import { Button } from './ui/button';

const SidebarItem = ({ to, icon, label }) => {
    const IconComponent = icon;

    return (
        <NavLink
            to={to}
            className={({ isActive }) =>
                cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-muted-foreground transition-all hover:text-primary",
                    isActive && "bg-muted text-primary"
                )
            }
        >
            <IconComponent className="h-4 w-4" />
            {label}
        </NavLink>
    );
};

const EMPTY_BUILDING_SUMMARY = {
    occupancy: 0,
    max_capacity: null,
    capacity_exceeded: false,
};

const NOTIFICATION_STORAGE_KEY = 'layout_notification_last_read_at';
const NOTIFICATION_CLEARED_STORAGE_KEY = 'layout_notification_cleared_at';
const NOTIFICATION_FETCH_LIMIT = 25;
const HAS_TZ_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/i;

const parseApiTimestampMs = (value) => {
    if (!value) return 0;

    const raw = String(value).trim();
    if (!raw) return 0;

    const normalized = HAS_TZ_SUFFIX.test(raw) ? raw : `${raw}Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

const formatNotificationTime = (value) => {
    const timestampMs = parseApiTimestampMs(value);
    if (!timestampMs) return '-';
    return new Date(timestampMs).toLocaleString();
};

const getInitialNotificationReadAt = () => {
    if (typeof window === 'undefined') {
        return Date.now();
    }

    const rawValue = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    const parsed = rawValue ? Date.parse(rawValue) : NaN;
    if (!Number.isNaN(parsed)) {
        return parsed;
    }

    const nowMs = Date.now();
    window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, new Date(nowMs).toISOString());
    return nowMs;
};

const getInitialNotificationClearedAt = () => {
    if (typeof window === 'undefined') {
        return 0;
    }

    const rawValue = window.localStorage.getItem(NOTIFICATION_CLEARED_STORAGE_KEY);
    const parsed = rawValue ? Date.parse(rawValue) : NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
};

const getNotificationSourceLabel = (event) => {
    if (event?.details?.scope === 'building') {
        return 'Building';
    }
    return (event?.camera_name || '').trim() || event?.camera_id || 'Unknown Camera';
};

const describeNotification = (event) => {
    if (event?.event_type === 'Capacity Exceeded') {
        const occupancy = event?.details?.occupancy ?? 0;
        const maxCapacity = event?.details?.max_capacity;
        return `Occupancy is ${occupancy}${maxCapacity ? ` / ${maxCapacity}` : ''}.`;
    }
    if (event?.event_type === 'Fall Detected') {
        return 'A person remained in a fall pose long enough to trigger an alert.';
    }

    const label = event?.details?.label;
    if (label) {
        return `${label} detected.`;
    }
    return 'Dress code violation detected.';
};

const Layout = ({ onLogout }) => {
    const apiUrl = getApiBaseUrl();
    const [buildingSummary, setBuildingSummary] = useState(EMPTY_BUILDING_SUMMARY);
    const [showBuildingCapacityPopup, setShowBuildingCapacityPopup] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [showNotificationsPanel, setShowNotificationsPanel] = useState(false);
    const [lastNotificationReadAt, setLastNotificationReadAt] = useState(getInitialNotificationReadAt);
    const [lastNotificationClearedAt, setLastNotificationClearedAt] = useState(getInitialNotificationClearedAt);
    const buildingCapacityWasExceededRef = useRef(false);
    const notificationsRef = useRef(null);

    const markNotificationsRead = useCallback((timestampMs) => {
        const nextReadAt = timestampMs || Date.now();
        setLastNotificationReadAt(nextReadAt);
        if (typeof window !== 'undefined') {
            window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, new Date(nextReadAt).toISOString());
        }
    }, []);

    const getLatestNotificationTimestamp = useCallback((items) => {
        if (!Array.isArray(items) || items.length === 0) {
            return Date.now();
        }
        return parseApiTimestampMs(items[0]?.timestamp) || Date.now();
    }, []);

    const clearNotifications = useCallback((timestampMs) => {
        const nextClearedAt = timestampMs || Date.now();
        setLastNotificationClearedAt(nextClearedAt);
        if (typeof window !== 'undefined') {
            window.localStorage.setItem(NOTIFICATION_CLEARED_STORAGE_KEY, new Date(nextClearedAt).toISOString());
        }
    }, []);

    useEffect(() => {
        let isMounted = true;

        const fetchBuildingSummary = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/building-occupancy-summary`);
                if (!res.ok) return;
                const data = await res.json();
                if (isMounted) {
                    const isExceeded = Boolean(data.capacity_exceeded);
                    setBuildingSummary({
                        occupancy: data.occupancy ?? 0,
                        max_capacity: data.max_capacity ?? null,
                        capacity_exceeded: isExceeded,
                    });
                    if (isExceeded && !buildingCapacityWasExceededRef.current) {
                        setShowBuildingCapacityPopup(true);
                    }
                    if (!isExceeded) {
                        setShowBuildingCapacityPopup(false);
                    }
                    buildingCapacityWasExceededRef.current = isExceeded;
                }
            } catch (err) {
                console.error('Failed to fetch building occupancy summary:', err);
            }
        };

        fetchBuildingSummary();
        const intervalId = setInterval(fetchBuildingSummary, 2000);

        return () => {
            isMounted = false;
            clearInterval(intervalId);
        };
    }, [apiUrl]);

    useEffect(() => {
        if (!showBuildingCapacityPopup) return undefined;

        const timeoutId = setTimeout(() => {
            setShowBuildingCapacityPopup(false);
        }, 8000);

        return () => clearTimeout(timeoutId);
    }, [showBuildingCapacityPopup]);

    useEffect(() => {
        let isMounted = true;

        const fetchNotifications = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/detection-events?limit=${NOTIFICATION_FETCH_LIMIT}`);
                if (!res.ok) return;

                const data = await res.json();
                if (!isMounted || !Array.isArray(data)) return;

                const relevantEvents = data.filter((event) => (
                    event?.event_type === 'Dress Code Violation'
                    || event?.event_type === 'Capacity Exceeded'
                    || event?.event_type === 'Fall Detected'
                ));

                setNotifications(relevantEvents);

                if (showNotificationsPanel && relevantEvents.length > 0) {
                    markNotificationsRead(getLatestNotificationTimestamp(relevantEvents));
                }
            } catch (err) {
                console.error('Failed to fetch notifications:', err);
            }
        };

        fetchNotifications();
        const intervalId = setInterval(fetchNotifications, 5000);

        return () => {
            isMounted = false;
            clearInterval(intervalId);
        };
    }, [apiUrl, getLatestNotificationTimestamp, markNotificationsRead, showNotificationsPanel]);

    useEffect(() => {
        if (!showNotificationsPanel) return undefined;

        const handlePointerDown = (event) => {
            if (notificationsRef.current && !notificationsRef.current.contains(event.target)) {
                setShowNotificationsPanel(false);
            }
        };

        const handleEscape = (event) => {
            if (event.key === 'Escape') {
                setShowNotificationsPanel(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [showNotificationsPanel]);

    const visibleNotifications = notifications.filter((event) => (
        parseApiTimestampMs(event?.timestamp) > lastNotificationClearedAt
    ));

    const unreadCount = visibleNotifications.filter((event) => (
        parseApiTimestampMs(event?.timestamp) > lastNotificationReadAt
    )).length;
    const currentUser = getStoredUser();
    const userInitial = (currentUser?.username || currentUser?.email || 'A').charAt(0).toUpperCase();

    const handleNotificationToggle = () => {
        setShowNotificationsPanel((current) => {
            const next = !current;
            if (!current) {
                markNotificationsRead(getLatestNotificationTimestamp(visibleNotifications));
            }
            return next;
        });
    };

    const handleClearNotifications = () => {
        clearNotifications(getLatestNotificationTimestamp(visibleNotifications));
        markNotificationsRead(getLatestNotificationTimestamp(visibleNotifications));
    };

    return (
        <div className="grid min-h-screen w-full md:grid-cols-[220px_1fr] lg:grid-cols-[280px_1fr]">
            {showBuildingCapacityPopup && (
                <div className="fixed right-6 top-6 z-50 w-full max-w-sm">
                    <div className="rounded-xl border border-red-500/30 bg-background shadow-xl">
                        <div className="flex items-start gap-3 p-4">
                            <div className="rounded-full bg-red-500/10 p-2 text-red-500">
                                <AlertTriangle className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold text-red-600">Building Capacity Exceeded</div>
                                <div className="mt-1 text-sm text-muted-foreground">
                                    Building occupancy is {buildingSummary.occupancy}
                                    {buildingSummary.max_capacity ? ` / ${buildingSummary.max_capacity}` : ''}.
                                </div>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                onClick={() => setShowBuildingCapacityPopup(false)}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </div>
            )}
            <div className="hidden border-r bg-muted/40 md:block">
                <div className="flex h-full max-h-screen flex-col gap-2">
                    <div className="flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
                        <a href="/" className="flex items-center gap-2 font-semibold">
                            <Activity className="h-6 w-6 text-primary" />
                            <span className="whitespace-nowrap">Entrance Analysis System</span>
                        </a>

                    </div>
                    <div className="flex-1">
                        <nav className="grid items-start px-2 text-sm font-medium lg:px-4">
                            <SidebarItem to="/" icon={LayoutDashboard} label="Main Monitoring" />
                            <SidebarItem to="/people-counting" icon={Users} label="People Counting Rules" />
                            <SidebarItem to="/dress-code" icon={Shirt} label="Dress Code Policy" />
                            <SidebarItem to="/fall-detection" icon={ArrowDownCircle} label="Fall Detection" />
                            <SidebarItem to="/reports" icon={BarChart3} label="Reporting" />
                            <SidebarItem to="/settings" icon={Settings} label="System Configuration" />
                        </nav>
                    </div>
                    <div className="mt-auto p-4">
                    </div>
                </div>
            </div>
            <div className="flex flex-col">
                <header className="flex h-14 items-center gap-4 border-b bg-muted/40 px-4 lg:h-[60px] lg:px-6">
                    <div className="w-full flex-1">
                        <form>
                            <div className="relative">
                                {/* Search placeholder */}
                            </div>
                        </form>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="relative" ref={notificationsRef}>
                            <button
                                className="relative h-8 w-8 rounded-full border bg-background p-0 text-muted-foreground hover:text-foreground"
                                onClick={handleNotificationToggle}
                                title="Notifications"
                                type="button"
                            >
                                <Bell className="h-4 w-4 mx-auto" />
                                {unreadCount > 0 && (
                                    <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
                                        {unreadCount > 99 ? '99+' : unreadCount}
                                    </span>
                                )}
                                <span className="sr-only">Toggle notifications</span>
                            </button>
                            {showNotificationsPanel && (
                                <div className="absolute right-0 top-10 z-50 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-background shadow-xl">
                                    <div className="flex items-center justify-between border-b px-4 py-3">
                                        <div>
                                            <div className="text-sm font-semibold text-foreground">Notifications</div>
                                            <div className="text-xs text-muted-foreground">
                                                {visibleNotifications.length === 0
                                                    ? 'No recent alerts'
                                                    : `${visibleNotifications.length} recent alert${visibleNotifications.length === 1 ? '' : 's'}`}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            {visibleNotifications.length > 0 && (
                                                <button
                                                    type="button"
                                                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                                                    onClick={handleClearNotifications}
                                                >
                                                    Clear alerts
                                                </button>
                                            )}
                                            <Link
                                                to="/reports"
                                                className="text-xs font-medium text-primary hover:underline"
                                                onClick={() => setShowNotificationsPanel(false)}
                                            >
                                                View reports
                                            </Link>
                                        </div>
                                    </div>
                                    <div className="max-h-[26rem] overflow-y-auto">
                                        {visibleNotifications.length === 0 ? (
                                            <div className="px-4 py-6 text-sm text-muted-foreground">
                                                No dress code, fall detection, or capacity alerts yet.
                                            </div>
                                        ) : (
                                            visibleNotifications.map((event) => {
                                                const isUnread = parseApiTimestampMs(event?.timestamp) > lastNotificationReadAt;
                                                const isCapacityEvent = event?.event_type === 'Capacity Exceeded';
                                                const isFallEvent = event?.event_type === 'Fall Detected';

                                                return (
                                                    <div
                                                        key={event.id}
                                                        className={cn(
                                                            'border-b px-4 py-3 last:border-b-0',
                                                            isUnread && 'bg-primary/5',
                                                        )}
                                                    >
                                                        <div className="flex items-start gap-3">
                                                            <div
                                                                className={cn(
                                                                    'mt-0.5 rounded-full p-2',
                                                                    isCapacityEvent
                                                                        ? 'bg-red-500/10 text-red-500'
                                                                        : isFallEvent
                                                                            ? 'bg-orange-500/10 text-orange-600'
                                                                            : 'bg-amber-500/10 text-amber-600',
                                                                )}
                                                            >
                                                                {isCapacityEvent ? (
                                                                    <AlertTriangle className="h-4 w-4" />
                                                                ) : isFallEvent ? (
                                                                    <ArrowDownCircle className="h-4 w-4" />
                                                                ) : (
                                                                    <Shirt className="h-4 w-4" />
                                                                )}
                                                            </div>
                                                            <div className="min-w-0 flex-1">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-sm font-medium text-foreground">
                                                                        {isCapacityEvent ? 'Maximum Capacity Exceeded' : isFallEvent ? 'Fall Detected' : 'Dress Code Violation'}
                                                                    </span>
                                                                    {isUnread && (
                                                                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                                                                            New
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="mt-1 text-sm text-muted-foreground">
                                                                    {describeNotification(event)}
                                                                </div>
                                                                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                                                                    <span className="truncate">{getNotificationSourceLabel(event)}</span>
                                                                    <span>{formatNotificationTime(event.timestamp)}</span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                        <Link to="/account" className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold hover:bg-primary/30 transition-colors">
                            {userInitial}
                        </Link>
                        <button onClick={onLogout} className="h-8 w-8 rounded-full border bg-background p-0 text-muted-foreground hover:text-foreground" title="Logout">
                            <LogOut className="h-4 w-4 mx-auto" />
                            <span className="sr-only">Logout</span>
                        </button>
                    </div>
                </header>
                <main className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6 bg-background">
                    <Outlet />
                </main>
            </div>
        </div>
    );
};

export default Layout;
