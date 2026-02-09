import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import {
    BarChart, Bar, LineChart, Line,
    XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer
} from 'recharts';
import { Download, Calendar, Eye, FileText, XCircle, AlertTriangle, RefreshCw, Users } from 'lucide-react';
import { cn } from '../lib/utils';
import { getApiBaseUrl } from '../apiConfig';

// --- Detail Modal ---
const DetailModal = ({ record, onClose, apiUrl }) => {
    if (!record) return null;

    const snapshotId = record.details?.snapshot_path ? record.id : null;
    const snapshotUrl = snapshotId ? `${apiUrl}/api/snapshots/${snapshotId}` : null;
    const isSnapshot = record._isSnapshot;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <Card className="w-full max-w-lg bg-background shadow-lg">
                <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
                    <CardTitle>{isSnapshot ? 'Counting Snapshot' : 'Event Details'}</CardTitle>
                    <Button variant="ghost" size="icon" onClick={onClose}><XCircle className="w-5 h-5" /></Button>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                    {!isSnapshot && (
                        <div className="aspect-video w-full bg-black/5 rounded-lg flex items-center justify-center border relative overflow-hidden">
                            {snapshotUrl ? (
                                <img src={snapshotUrl} alt="Evidence" className="object-contain w-full h-full"
                                    onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
                            ) : null}
                            <span className="text-muted-foreground absolute" style={{ display: snapshotUrl ? 'none' : 'flex' }}>
                                No Snapshot Available
                            </span>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                            <p className="text-muted-foreground font-medium">ID</p>
                            <p className="font-mono text-xs">{record.id}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Timestamp</p>
                            <p>{new Date(record.timestamp).toLocaleString()}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Camera</p>
                            <p className="truncate">{record.camera_id}</p>
                        </div>

                        {isSnapshot ? (
                            <>
                                <div>
                                    <p className="text-muted-foreground font-medium">Total In</p>
                                    <p className="text-green-500 font-bold">{record.total_in}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground font-medium">Total Out</p>
                                    <p className="text-red-500 font-bold">{record.total_out}</p>
                                </div>
                                <div>
                                    <p className="text-muted-foreground font-medium">Occupancy</p>
                                    <p className="text-primary font-bold">{record.current_occupancy}</p>
                                </div>
                            </>
                        ) : (
                            <>
                                <div>
                                    <p className="text-muted-foreground font-medium">Event Type</p>
                                    <div className="flex items-center gap-2">
                                        <AlertTriangle className="w-3 h-3 text-red-500" />
                                        {record.event_type}
                                    </div>
                                </div>
                                {record.details?.label && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Classification</p>
                                        <p>{record.details.label.replace(/_/g, ' ')}</p>
                                    </div>
                                )}
                                {record.details?.confidence && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Confidence</p>
                                        <p>{Math.round(record.details.confidence * 100)}%</p>
                                    </div>
                                )}
                                {record.details?.track_id && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Track ID</p>
                                        <p className="font-mono">{record.details.track_id}</p>
                                    </div>
                                )}
                                {record.details?.occupancy !== undefined && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Occupancy</p>
                                        <p>{record.details.occupancy}</p>
                                    </div>
                                )}
                                {record.details?.max_capacity !== undefined && (
                                    <div>
                                        <p className="text-muted-foreground font-medium">Max Capacity</p>
                                        <p>{record.details.max_capacity}</p>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

// --- Export Dialog ---
const ExportDialog = ({ isOpen, onClose, onExport }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <Card className="w-full max-w-sm">
                <CardHeader><CardTitle>Export Report</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">Select the format you wish to download.</p>
                    <div className="grid grid-cols-2 gap-3">
                        <Button variant="outline" className="flex flex-col h-20 items-center justify-center gap-2 hover:bg-primary/5 hover:border-primary" onClick={() => onExport('CSV')}>
                            <FileText className="w-6 h-6" /> CSV
                        </Button>
                        <Button variant="outline" className="flex flex-col h-20 items-center justify-center gap-2 hover:bg-primary/5 hover:border-primary" onClick={() => onExport('PDF')}>
                            <FileText className="w-6 h-6" /> PDF
                        </Button>
                    </div>
                    <Button variant="ghost" className="w-full" onClick={onClose}>Cancel</Button>
                </CardContent>
            </Card>
        </div>
    );
};

// --- Occupancy Over Time Chart ---
const OccupancyChart = ({ apiUrl, cameras }) => {
    const [selectedCamera, setSelectedCamera] = useState('');
    const [historyData, setHistoryData] = useState([]);
    const [loading, setLoading] = useState(false);

    // Auto-select first camera
    useEffect(() => {
        if (!selectedCamera && cameras.length > 0) {
            setSelectedCamera(cameras[0].id);
        }
    }, [cameras, selectedCamera]);

    useEffect(() => {
        if (!selectedCamera) return;
        const fetchHistory = async () => {
            setLoading(true);
            try {
                const res = await fetch(`${apiUrl}/api/people-counting-history?camera_id=${selectedCamera}&limit=100`);
                if (res.ok) {
                    const data = await res.json();
                    const chartData = data.reverse().map(s => ({
                        time: new Date(s.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                        in: s.total_in,
                        out: s.total_out,
                        occupancy: s.current_occupancy,
                    }));
                    setHistoryData(chartData);
                }
            } catch (err) {
                console.error('Failed to fetch counting history:', err);
            }
            setLoading(false);
        };
        fetchHistory();
        const interval = setInterval(fetchHistory, 15000);
        return () => clearInterval(interval);
    }, [apiUrl, selectedCamera]);

    return (
        <Card className="flex flex-col min-h-[350px]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    Occupancy Over Time
                </CardTitle>
                <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    value={selectedCamera}
                    onChange={(e) => setSelectedCamera(e.target.value)}
                >
                    <option value="">Select camera...</option>
                    {cameras.map(cam => (
                        <option key={cam.id} value={cam.id}>{cam.name}</option>
                    ))}
                </select>
            </CardHeader>
            <CardContent className="flex-1 min-h-[250px]">
                {historyData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={historyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                            <XAxis dataKey="time" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                            <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                            <RechartsTooltip
                                cursor={{ strokeDasharray: '3 3' }}
                                contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                            />
                            <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                            <Line type="monotone" dataKey="occupancy" name="Occupancy" stroke="#3b82f6" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="in" name="Total In" stroke="#22c55e" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="out" name="Total Out" stroke="#ef4444" strokeWidth={2} dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        {loading ? 'Loading...' : selectedCamera ? 'No occupancy data available' : 'Select a camera to view occupancy history'}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

// --- Main Reporting Component ---
const Reporting = () => {
    const apiUrl = getApiBaseUrl();

    const [events, setEvents] = useState([]);
    const [countingSnapshots, setCountingSnapshots] = useState([]);
    const [cameras, setCameras] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedCategory, setSelectedCategory] = useState('All');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [selectedRecord, setSelectedRecord] = useState(null);
    const [showExportModal, setShowExportModal] = useState(false);

    // Fetch cameras
    useEffect(() => {
        const fetchCameras = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/cameras`);
                const data = await res.json();
                setCameras(data.filter(c => c.enabled));
            } catch (err) {
                console.error('Failed to fetch cameras:', err);
            }
        };
        fetchCameras();
    }, [apiUrl]);

    // Fetch detection events
    const fetchEvents = useCallback(async () => {
        setLoading(true);
        try {
            let url = `${apiUrl}/api/detection-events?limit=200`;
            if (selectedCategory === 'Dress Code') {
                url += '&event_type=Dress Code Violation';
            } else if (selectedCategory === 'People Counting') {
                url += '&event_type=Capacity Exceeded';
            }
            const res = await fetch(url);
            const data = await res.json();
            setEvents(data);
        } catch (err) {
            console.error("Failed to fetch events:", err);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, selectedCategory]);

    // Fetch counting snapshots when People Counting category is selected
    const fetchCountingSnapshots = useCallback(async () => {
        if (selectedCategory !== 'People Counting' && selectedCategory !== 'All') {
            setCountingSnapshots([]);
            return;
        }
        try {
            // Fetch snapshots for all cameras
            const allSnapshots = [];
            for (const cam of cameras) {
                const res = await fetch(`${apiUrl}/api/people-counting-history?camera_id=${cam.id}&limit=200`);
                if (res.ok) {
                    const data = await res.json();
                    allSnapshots.push(...data.map(s => ({ ...s, _isSnapshot: true, camera_name: cam.name })));
                }
            }
            // Sort by timestamp descending (newest first)
            allSnapshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            setCountingSnapshots(allSnapshots);
        } catch (err) {
            console.error("Failed to fetch counting snapshots:", err);
        }
    }, [apiUrl, cameras, selectedCategory]);

    useEffect(() => {
        fetchEvents();
        const interval = setInterval(fetchEvents, 10000);
        return () => clearInterval(interval);
    }, [fetchEvents]);

    useEffect(() => {
        if (cameras.length > 0) {
            fetchCountingSnapshots();
            const interval = setInterval(fetchCountingSnapshots, 15000);
            return () => clearInterval(interval);
        }
    }, [fetchCountingSnapshots, cameras]);

    // Date filter helper
    const dateFilter = (timestamp) => {
        if (startDate) {
            const d = new Date(timestamp).toISOString().split('T')[0];
            if (d < startDate) return false;
        }
        if (endDate) {
            const d = new Date(timestamp).toISOString().split('T')[0];
            if (d > endDate) return false;
        }
        return true;
    };

    // Filtered events
    const filteredEvents = events.filter(evt => dateFilter(evt.timestamp));

    // Filtered counting snapshots
    const filteredSnapshots = countingSnapshots.filter(s => dateFilter(s.timestamp));

    // Build combined display rows for log table
    const displayRows = (() => {
        if (selectedCategory === 'People Counting') {
            // Show counting snapshots as log entries (plus any capacity alerts)
            const snapshotRows = filteredSnapshots.map(s => ({
                id: s.id,
                timestamp: s.timestamp,
                event_type: 'Counting Snapshot',
                camera_id: s.camera_id,
                camera_name: s.camera_name,
                total_in: s.total_in,
                total_out: s.total_out,
                current_occupancy: s.current_occupancy,
                _isSnapshot: true,
            }));
            const eventRows = filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
            // Merge and sort by timestamp desc
            return [...eventRows, ...snapshotRows].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }
        if (selectedCategory === 'All') {
            const snapshotRows = filteredSnapshots.slice(0, 50).map(s => ({
                id: s.id,
                timestamp: s.timestamp,
                event_type: 'Counting Snapshot',
                camera_id: s.camera_id,
                camera_name: s.camera_name,
                total_in: s.total_in,
                total_out: s.total_out,
                current_occupancy: s.current_occupancy,
                _isSnapshot: true,
            }));
            const eventRows = filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
            return [...eventRows, ...snapshotRows].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }
        // Dress Code only
        return filteredEvents.map(e => ({ ...e, _isSnapshot: false }));
    })();

    // Build chart data
    const chartData = (() => {
        if (selectedCategory === 'People Counting') {
            // Aggregate counting snapshots by day: show max IN/OUT per day
            const byDay = {};
            filteredSnapshots.forEach(s => {
                const day = new Date(s.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                if (!byDay[day]) byDay[day] = { name: day, totalIn: 0, totalOut: 0, maxOccupancy: 0 };
                byDay[day].totalIn = Math.max(byDay[day].totalIn, s.total_in);
                byDay[day].totalOut = Math.max(byDay[day].totalOut, s.total_out);
                byDay[day].maxOccupancy = Math.max(byDay[day].maxOccupancy, s.current_occupancy);
            });
            return Object.values(byDay).slice(-7);
        }
        // Detection events aggregated by day
        const byDay = {};
        filteredEvents.forEach(evt => {
            const day = new Date(evt.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (!byDay[day]) byDay[day] = { name: day, violations: 0 };
            byDay[day].violations++;
        });
        return Object.values(byDay).slice(-7);
    })();

    const isPeopleCountingChart = selectedCategory === 'People Counting';
    const totalDisplayRows = displayRows.length;

    // Handlers
    const handleCategoryChange = (cat) => setSelectedCategory(cat);

    const handleDownload = (format) => {
        setShowExportModal(false);
        if (format === 'CSV') {
            let csv;
            if (selectedCategory === 'People Counting') {
                csv = 'Timestamp,Camera,Total In,Total Out,Occupancy\n';
                csv += filteredSnapshots.map(s =>
                    `${s.timestamp},${s.camera_id},${s.total_in},${s.total_out},${s.current_occupancy}`
                ).join('\n');
            } else {
                csv = 'ID,Timestamp,Event Type,Camera,Label,Confidence\n';
                csv += filteredEvents.map(e =>
                    `${e.id},${e.timestamp},${e.event_type},${e.camera_id},${e.details?.label || ''},${e.details?.confidence || ''}`
                ).join('\n');
            }
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `report_${selectedCategory.replace(/\s/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
            link.click();
            URL.revokeObjectURL(url);
        } else {
            alert('PDF export not implemented yet.');
        }
    };

    return (
        <div className="flex flex-col h-full bg-background p-6 gap-6 overflow-hidden">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
                <h1 className="text-3xl font-bold tracking-tight">Reporting Dashboard</h1>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => { fetchEvents(); fetchCountingSnapshots(); }} disabled={loading} className="gap-2">
                        <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Refresh
                    </Button>
                    <Button onClick={() => setShowExportModal(true)} className="gap-2">
                        <Download className="w-4 h-4" /> Export Report
                    </Button>
                </div>
            </div>

            {/* Filter Bar */}
            <Card className="shrink-0">
                <CardContent className="p-4 flex flex-wrap items-end gap-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Report Category</label>
                        <div className="flex bg-muted rounded-md p-1 h-10 items-center">
                            {['All', 'Dress Code', 'People Counting'].map(cat => (
                                <button key={cat} onClick={() => handleCategoryChange(cat)}
                                    className={cn("px-3 py-1.5 text-sm font-medium rounded-sm transition-all flex-1 whitespace-nowrap",
                                        selectedCategory === cat ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}>
                                    {cat}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-medium">Date Range</label>
                        <div className="flex items-center gap-2">
                            <div className="relative">
                                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input type="date"
                                    className="h-10 rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                            </div>
                            <span className="text-muted-foreground">-</span>
                            <div className="relative">
                                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input type="date"
                                    className="h-10 rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                            </div>
                        </div>
                    </div>

                    <div className="text-sm text-muted-foreground ml-auto self-end pb-2">
                        {totalDisplayRows} record{totalDisplayRows !== 1 ? 's' : ''} found
                    </div>
                </CardContent>
            </Card>

            {/* Charts & Log */}
            <div className="flex-1 overflow-y-auto grid md:grid-cols-2 gap-6 min-h-0">
                {/* Events / Counting by Day Chart */}
                <Card className="flex flex-col min-h-[350px]">
                    <CardHeader>
                        <CardTitle>{isPeopleCountingChart ? 'Counting by Day' : 'Events by Day'}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-[250px]">
                        {chartData.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                {isPeopleCountingChart ? (
                                    <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                        <XAxis dataKey="name" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                        <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                        <RechartsTooltip cursor={{ fill: 'transparent' }}
                                            contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} />
                                        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                        <Bar dataKey="totalIn" name="Total In" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                        <Bar dataKey="totalOut" name="Total Out" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                        <Bar dataKey="maxOccupancy" name="Peak Occupancy" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                    </BarChart>
                                ) : (
                                    <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                        <XAxis dataKey="name" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                        <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                                        <RechartsTooltip cursor={{ fill: 'transparent' }}
                                            contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }} />
                                        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                        <Bar dataKey="violations" name="Events" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                    </BarChart>
                                )}
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                                No data to display
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Occupancy Over Time */}
                <OccupancyChart apiUrl={apiUrl} cameras={cameras} />

                {/* Log Table */}
                <Card className="flex flex-col min-h-[350px] md:col-span-2 overflow-hidden">
                    <CardHeader>
                        <CardTitle>
                            {selectedCategory === 'People Counting' ? 'Counting Log' : 'Detection Event Logs'}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 p-0 overflow-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="text-muted-foreground bg-muted/50 sticky top-0">
                                <tr>
                                    <th className="px-4 py-3 font-medium">Timestamp</th>
                                    <th className="px-4 py-3 font-medium">Type</th>
                                    <th className="px-4 py-3 font-medium">Details</th>
                                    <th className="px-4 py-3 font-medium text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {displayRows.length > 0 ? displayRows.map(row => {
                                    if (row._isSnapshot) {
                                        return (
                                            <tr key={row.id} className="hover:bg-muted/30 transition-colors cursor-pointer"
                                                onClick={() => setSelectedRecord(row)}>
                                                <td className="px-4 py-3">{new Date(row.timestamp).toLocaleString()}</td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <div className="w-2 h-2 rounded-full bg-blue-500" />
                                                        Counting Snapshot
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-muted-foreground">
                                                    <span className="inline-flex gap-3">
                                                        <span className="text-green-500 font-medium">IN: {row.total_in}</span>
                                                        <span className="text-red-500 font-medium">OUT: {row.total_out}</span>
                                                        <span className="text-primary font-medium">Occupancy: {row.current_occupancy}</span>
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-right">
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <Eye className="w-4 h-4" />
                                                    </Button>
                                                </td>
                                            </tr>
                                        );
                                    }

                                    const isCapacity = row.event_type === 'Capacity Exceeded';
                                    const dotColor = isCapacity ? 'bg-orange-500' : 'bg-red-500';
                                    return (
                                        <tr key={row.id} className="hover:bg-muted/30 transition-colors group cursor-pointer"
                                            onClick={() => setSelectedRecord(row)}>
                                            <td className="px-4 py-3">{new Date(row.timestamp).toLocaleString()}</td>
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-2">
                                                    <div className={cn("w-2 h-2 rounded-full", dotColor)} />
                                                    {row.event_type}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {isCapacity ? (
                                                    <span>Occupancy: {row.details?.occupancy ?? '-'} / {row.details?.max_capacity ?? '-'}</span>
                                                ) : (
                                                    <span>
                                                        {row.details?.label?.replace(/_/g, ' ') || '-'}
                                                        {row.details?.confidence ? ` (${Math.round(row.details.confidence * 100)}%)` : ''}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Eye className="w-4 h-4" />
                                                </Button>
                                            </td>
                                        </tr>
                                    );
                                }) : (
                                    <tr>
                                        <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                                            {loading ? "Loading..." : "No records found."}
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>
            </div>

            {/* Modals */}
            <DetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} apiUrl={apiUrl} />
            <ExportDialog isOpen={showExportModal} onClose={() => setShowExportModal(false)} onExport={handleDownload} />
        </div>
    );
};

export default Reporting;
