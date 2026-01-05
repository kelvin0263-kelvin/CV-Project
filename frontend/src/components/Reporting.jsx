import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from 'recharts';
import { Download, Calendar, Filter, Eye, FileText, CheckCircle, XCircle, AlertTriangle, User } from 'lucide-react';
import { cn } from '../lib/utils';

// --- Mock Data ---

const REPORT_DATA = {
    weekly: [
        { name: 'Mon', people: 1450, violations: 12 },
        { name: 'Tue', people: 2300, violations: 18 },
        { name: 'Wed', people: 1800, violations: 8 },
        { name: 'Thu', people: 2100, violations: 25 },
        { name: 'Fri', people: 2900, violations: 15 },
        { name: 'Sat', people: 1100, violations: 5 },
        { name: 'Sun', people: 950, violations: 2 },
    ],
    logs: [
        { id: 101, timestamp: '2023-12-14 09:12:45', type: 'Dress Code Violation', camera: 'Factory Floor A', details: 'Missing Helmet', status: 'Reviewed', trackingId: 'TRK-001' },
        { id: 102, timestamp: '2023-12-14 09:15:20', type: 'People Count', camera: 'Main Lobby', details: 'Entry Detected', status: 'Logged', trackingId: 'TRK-002' },
        { id: 103, timestamp: '2023-12-14 09:30:10', type: 'Dress Code Violation', camera: 'Factory Floor A', details: 'Missing Vest', status: 'New', trackingId: 'TRK-003' },
        { id: 104, timestamp: '2023-12-14 10:05:00', type: 'People Count', camera: 'Back Entrance', details: 'Exit Detected', status: 'Logged', trackingId: 'TRK-004' },
        { id: 105, timestamp: '2023-12-14 10:45:33', type: 'Dress Code Violation', camera: 'Corridor B', details: 'Unknown Person', status: 'New', trackingId: 'TRK-005' },
        { id: 106, timestamp: '2023-12-14 11:30:15', type: 'Fall Detection', camera: 'Parking Lot', details: 'Hard Impact Detected', status: 'Alert', trackingId: 'TRK-006' },
    ]
};

// --- Components ---

const DetailModal = ({ record, onClose }) => {
    if (!record) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <Card className="w-full max-w-lg bg-background shadow-lg">
                <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
                    <CardTitle>Event Details</CardTitle>
                    <Button variant="ghost" size="icon" onClick={onClose}><XCircle className="w-5 h-5" /></Button>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                    <div className="aspect-video w-full bg-black/5 rounded-lg flex items-center justify-center border relative overflow-hidden">
                        <img src="/placeholder_evidence.png" alt="Evidence" className="opacity-50 object-cover w-full h-full" onError={(e) => e.target.style.display = 'none'} />
                        <span className="text-muted-foreground absolute">Snapshot Evidence</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                            <p className="text-muted-foreground font-medium">Tracking ID</p>
                            <p className="font-mono">{record.trackingId}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Timestamp</p>
                            <p>{record.timestamp}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Camera Source</p>
                            <p>{record.camera}</p>
                        </div>
                        <div>
                            <p className="text-muted-foreground font-medium">Event Type</p>
                            <div className="flex items-center gap-2">
                                {record.type.includes('Dress') ? <AlertTriangle className="w-3 h-3 text-red-500" /> : <User className="w-3 h-3 text-blue-500" />}
                                {record.type}
                            </div>
                        </div>
                        <div className="col-span-2">
                            <p className="text-muted-foreground font-medium">Description</p>
                            <p>{record.details}</p>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

const ExportDialog = ({ isOpen, onClose, onExport }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <Card className="w-full max-w-sm">
                <CardHeader>
                    <CardTitle>Export Report</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">Select the format you wish to download.</p>
                    <div className="grid grid-cols-2 gap-3">
                        <Button variant="outline" className="flex flex-col h-20 items-center justify-center gap-2 hover:bg-primary/5 hover:border-primary" onClick={() => onExport('CSV')}>
                            <FileText className="w-6 h-6" />
                            CSV
                        </Button>
                        <Button variant="outline" className="flex flex-col h-20 items-center justify-center gap-2 hover:bg-primary/5 hover:border-primary" onClick={() => onExport('PDF')}>
                            <FileText className="w-6 h-6" />
                            PDF
                        </Button>
                    </div>
                    <Button variant="ghost" className="w-full" onClick={onClose}>Cancel</Button>
                </CardContent>
            </Card>
        </div>
    );
};

const Reporting = () => {
    // State
    const [selectedCategory, setSelectedCategory] = useState('All');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [selectedRecord, setSelectedRecord] = useState(null);
    const [showExportModal, setShowExportModal] = useState(false);

    // Derived Data (Filter Logic Mockup)
    const filteredLogs = REPORT_DATA.logs.filter(log => {
        if (selectedCategory !== 'All' && !log.type.includes(selectedCategory)) return false;
        // Date filtering logic would go here
        return true;
    });

    // Handlers
    const handleCategoryChange = (cat) => setSelectedCategory(cat);

    const handleExportClick = () => setShowExportModal(true);

    const handleDownload = (format) => {
        // Simulate Download
        setShowExportModal(false);
        const link = document.createElement('a');
        link.href = '#';
        link.download = `report_${new Date().toISOString().split('T')[0]}.${format.toLowerCase()}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        alert(`Downloading Report as ${format}...`);
    };

    return (
        <div className="flex flex-col h-full bg-background p-6 gap-6 overflow-hidden">
            {/* Header & Controls */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
                <h1 className="text-3xl font-bold tracking-tight">Reporting Dashboard</h1>
                <div className="flex items-center gap-2">
                    <Button onClick={handleExportClick} className="gap-2">
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
                            {['All', 'People Count', 'Dress Code', 'Fall Detection'].map(cat => (
                                <button
                                    key={cat}
                                    onClick={() => handleCategoryChange(cat)}
                                    className={cn(
                                        "px-3 py-1.5 text-sm font-medium rounded-sm transition-all flex-1 whitespace-nowrap",
                                        selectedCategory === cat ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
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
                                <input
                                    type="date"
                                    className="h-10 rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    value={startDate}
                                    onChange={(e) => setStartDate(e.target.value)}
                                />
                            </div>
                            <span className="text-muted-foreground">-</span>
                            <div className="relative">
                                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="date"
                                    className="h-10 rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    value={endDate}
                                    onChange={(e) => setEndDate(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2 ml-auto">
                        <label className="text-sm font-medium opacity-0">Action</label>
                        <Button variant="outline" className="w-full gap-2">
                            <Filter className="w-3 h-3" /> Apply Filters
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto grid md:grid-cols-2 gap-6 min-h-0">
                {/* Visuals */}
                <Card className="flex flex-col h-[400px] md:h-auto">
                    <CardHeader>
                        <CardTitle>Trend Analysis</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 min-h-0">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={REPORT_DATA.weekly} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                                <XAxis dataKey="name" className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                <YAxis className="text-xs text-muted-foreground" tickLine={false} axisLine={false} />
                                <RechartsTooltip
                                    cursor={{ fill: 'transparent' }}
                                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                                />
                                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                                <Bar dataKey="people" name="People Traffic" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                                <Bar dataKey="violations" name="Violations" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                            </BarChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>

                {/* Data Table */}
                <Card className="flex flex-col h-[400px] md:h-auto overflow-hidden">
                    <CardHeader>
                        <CardTitle>Detailed Event Logs</CardTitle>
                    </CardHeader>
                    <CardContent className="flex-1 p-0 overflow-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="text-muted-foreground bg-muted/50 sticky top-0">
                                <tr>
                                    <th className="px-4 py-3 font-medium">Timestamp</th>
                                    <th className="px-4 py-3 font-medium">Event Type</th>
                                    <th className="px-4 py-3 font-medium">Camera</th>
                                    <th className="px-4 py-3 font-medium">Status</th>
                                    <th className="px-4 py-3 font-medium text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {filteredLogs.length > 0 ? filteredLogs.map(log => (
                                    <tr key={log.id} className="hover:bg-muted/30 transition-colors group cursor-pointer" onClick={() => setSelectedRecord(log)}>
                                        <td className="px-4 py-3">{log.timestamp}</td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2">
                                                {log.type.includes('Dress') ? <div className="w-2 h-2 rounded-full bg-red-500" /> :
                                                    log.type.includes('Fall') ? <div className="w-2 h-2 rounded-full bg-orange-500" /> :
                                                        <div className="w-2 h-2 rounded-full bg-blue-500" />}
                                                {log.type}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-muted-foreground">{log.camera}</td>
                                        <td className="px-4 py-3">
                                            <span className={cn("px-2 py-0.5 rounded text-xs font-medium",
                                                log.status === 'Logged' ? "bg-secondary text-foreground" :
                                                    log.status === 'New' ? "bg-red-500/10 text-red-500" :
                                                        log.status === 'Alert' ? "bg-orange-500/10 text-orange-500" :
                                                            "bg-green-500/10 text-green-500"
                                            )}>
                                                {log.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <Eye className="w-4 h-4" />
                                            </Button>
                                        </td>
                                    </tr>
                                )) : (
                                    <tr>
                                        <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No records found for the selected criteria.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </CardContent>
                </Card>
            </div>

            {/* Modals */}
            <DetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
            <ExportDialog isOpen={showExportModal} onClose={() => setShowExportModal(false)} onExport={handleDownload} />
        </div>
    );
};

export default Reporting;
