import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Activity, Save, Timer, AlertTriangle, Zap } from 'lucide-react';

const FallDetection = () => {
    const [sensitivity, setSensitivity] = useState(75);
    const [hardImpact, setHardImpact] = useState(true);
    const [inactivityTimer, setInactivityTimer] = useState(30);
    const [selectedCamera, setSelectedCamera] = useState('4');

    // Mock Cameras
    const cameras = [
        { id: '1', name: 'Main Entrance' },
        { id: '2', name: 'Factory Floor A' },
        { id: '4', name: 'Parking Lot' },
    ];

    const handleSave = () => {
        alert(`Fall Detection Configuration Saved:\nSensitivity: ${sensitivity}\nHard Impact: ${hardImpact}\nInactivity Timer: ${inactivityTimer}s`);
    };

    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">Fall Detection Configuration</h1>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
                {/* Configuration Sidebar */}
                <Card className="lg:col-span-1 h-fit">
                    <CardHeader>
                        <CardTitle>Detection Parameters</CardTitle>
                        <CardDescription>Configure sensitivity and triggers.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Select Camera</label>
                            <select
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                value={selectedCamera}
                                onChange={(e) => setSelectedCamera(e.target.value)}
                            >
                                {cameras.map(cam => (
                                    <option key={cam.id} value={cam.id}>{cam.name}</option>
                                ))}
                            </select>
                        </div>

                        <div className="space-y-4">
                            <div className="flex justify-between">
                                <label className="text-sm font-medium">Detection Sensitivity</label>
                                <span className="text-sm text-muted-foreground">{sensitivity}%</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={sensitivity}
                                onChange={(e) => setSensitivity(e.target.value)}
                                className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                            />
                            <p className="text-xs text-muted-foreground">Adjust how easily a fall is triggered. Higher values increase detection rate but may cause false positives.</p>
                        </div>

                        <div className="flex items-center justify-between border p-3 rounded-md">
                            <div className="flex items-center space-x-2">
                                <Zap className="h-4 w-4 text-orange-500" />
                                <label className="text-sm font-medium">Hard Impact Fall</label>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" checked={hardImpact} onChange={(e) => setHardImpact(e.target.checked)} className="sr-only peer" />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                            </label>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0">Detects sudden high-velocity impacts with the ground.</p>


                        <div className="space-y-2">
                            <label className="text-sm font-medium">Inactivity Timer (Seconds)</label>
                            <div className="relative">
                                <Timer className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="number"
                                    min="0"
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                    value={inactivityTimer}
                                    onChange={(e) => setInactivityTimer(e.target.value)}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">Time person remains on floor before alert is sent.</p>
                        </div>

                        <div className="pt-4 flex justify-end">
                            <Button onClick={handleSave} className="w-full">
                                <Save className="w-4 h-4 mr-2" />
                                Save Configuration
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Video Area Mockup */}
                <Card className="lg:col-span-2 overflow-hidden flex flex-col bg-black">
                    <div className="relative flex-1 bg-muted flex items-center justify-center min-h-[400px]">
                        <img src="/4.png" className="w-full h-full object-cover opacity-60" alt="Fall Detection Camera" />
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="border-2 border-orange-500 bg-orange-500/10 p-4 rounded animate-pulse">
                                <p className="text-orange-500 font-bold flex items-center gap-2">
                                    <Activity className="h-5 w-5" />
                                    Monitoring Active
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="p-2 bg-card border-t flex justify-between items-center text-xs text-muted-foreground">
                        <span>Resolution: 1920x1080</span>
                        <span>FPS: 30</span>
                    </div>
                </Card>
            </div>
        </div>
    );
};

export default FallDetection;
