import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { MousePointer2, PenTool, Check, Save } from 'lucide-react';
import { cn } from '../lib/utils';

const PeopleCounting = () => {
    const [selectedCamera, setSelectedCamera] = useState('1');
    const [drawingMode, setDrawingMode] = useState(null); // 'line' or 'roi'
    const [maxCapacity, setMaxCapacity] = useState(100);
    const [roiPoints, setRoiPoints] = useState([]);
    const [linePoints, setLinePoints] = useState([]);

    // Mock Cameras
    const cameras = [
        { id: '1', name: 'Main Entrance' },
        { id: '2', name: 'Side Gate' },
        { id: '3', name: 'Lobby' },
    ];

    const handleDrawingMode = (mode) => {
        setDrawingMode(mode);
        // In a real app, this would enable a canvas overlay interactions
    };

    const handleSave = () => {
        // Validation logic
        if (maxCapacity <= 0) {
            alert("Please enter correct capacity value");
            return;
        }
        if (drawingMode === 'roi' && roiPoints.length < 3) {
            // Mock validation for ROI
            // alert("Invalid Region of Interest"); // Uncomment if we had real points
        }

        alert("Configuration Saved Successfully");
    };

    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">Configure People Counting</h1>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">
                {/* Configuration Sidebar */}
                <Card className="lg:col-span-1 h-fit">
                    <CardHeader>
                        <CardTitle>Settings</CardTitle>
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
                            <div className="text-sm font-medium">Drawing Tools</div>
                            <div className="flex gap-2">
                                <Button
                                    variant={drawingMode === 'line' ? "default" : "outline"}
                                    className="flex-1"
                                    onClick={() => handleDrawingMode('line')}
                                >
                                    <PenTool className="w-4 h-4 mr-2" />
                                    Draw Line
                                </Button>
                                <Button
                                    variant={drawingMode === 'roi' ? "default" : "outline"}
                                    className="flex-1"
                                    onClick={() => handleDrawingMode('roi')}
                                >
                                    <MousePointer2 className="w-4 h-4 mr-2" />
                                    Draw ROI
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {drawingMode === 'line' ? "Click and drag to draw a crossing line on the video." :
                                    drawingMode === 'roi' ? "Click points to define a polygon region. Double click to close." :
                                        "Select a tool to configure detection zones."}
                            </p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium">Max Occupancy Capacity</label>
                            <input
                                type="number"
                                min="1"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                value={maxCapacity}
                                onChange={(e) => setMaxCapacity(e.target.value)}
                            />
                        </div>

                        <div className="pt-4 flex justify-end">
                            <Button onClick={handleSave} className="w-full">
                                <Save className="w-4 h-4 mr-2" />
                                Save Configuration Option
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Video Area */}
                <Card className="lg:col-span-2 overflow-hidden flex flex-col bg-black">
                    <div className="relative flex-1 bg-muted flex items-center justify-center min-h-[400px]">
                        {/* Simulated Video Frame */}
                        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground overflow-hidden">
                            <img src="/3.png" className="w-full h-full object-cover opacity-60" alt="Camera Feed" />
                            <div className="absolute text-center z-10 pointer-events-none">
                                <p className="mb-2 font-bold text-white drop-shadow-md">Camera Feed: {cameras.find(c => c.id === selectedCamera)?.name}</p>
                            </div>
                        </div>

                        {/* Interactive Overlay Mockup */}
                        {drawingMode === 'line' && (
                            <div className="absolute inset-0 pointer-events-none">
                                <svg className="w-full h-full">
                                    <line x1="20%" y1="50%" x2="80%" y2="50%" stroke="yellow" strokeWidth="4" strokeDasharray="5,5" />
                                    <text x="50%" y="45%" fill="yellow" textAnchor="middle" className="text-xs font-bold">CROSSING LINE</text>
                                </svg>
                            </div>
                        )}

                        {drawingMode === 'roi' && (
                            <div className="absolute inset-0 pointer-events-none">
                                <svg className="w-full h-full">
                                    <polygon points="100,100 400,100 400,300 100,300" fill="rgba(66, 153, 225, 0.2)" stroke="#4299e1" strokeWidth="2" />
                                    <text x="250" y="200" fill="#4299e1" textAnchor="middle" className="text-xs font-bold">REGION OF INTEREST</text>
                                </svg>
                            </div>
                        )}
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

export default PeopleCounting;
