import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { ShieldCheck, Save, Percent } from 'lucide-react';
import { cn } from '../lib/utils';

const DressCode = () => {
    const [selectedCamera, setSelectedCamera] = useState('1');
    const [confidence, setConfidence] = useState(80);
    const [clothingItems, setClothingItems] = useState([
        { id: 'sleeveless', name: 'Sleeveless Tops', required: true },
        { id: 'shorts', name: 'Short Pants', required: true },
        { id: 'slippers', name: 'Slippers', required: true },
        { id: 'skirts', name: 'Skirts', required: false },
    ]);

    // Mock Cameras
    const cameras = [
        { id: '1', name: 'Office Entrance' },
        { id: '2', name: 'Laboratory' },
        { id: '3', name: 'Meeting Room' },
    ];

    const toggleItem = (id) => {
        setClothingItems(prev => prev.map(item =>
            item.id === id ? { ...item, required: !item.required } : item
        ));
    };

    const handleSave = () => {
        alert("Policy Saved Successfully");
        // Save to database logic
    };

    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">Configure Dress Code Policy</h1>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Configuration Sidebar */}
                <Card className="lg:col-span-1">
                    <CardHeader>
                        <CardTitle>Policy Settings</CardTitle>
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

                        <div className="space-y-2">
                            <label className="text-sm font-medium flex justify-between">
                                <span>Detection Confidence</span>
                                <span className="text-muted-foreground">{confidence}%</span>
                            </label>
                            <input
                                type="range"
                                min="50"
                                max="99"
                                value={confidence}
                                onChange={(e) => setConfidence(e.target.value)}
                                className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                            />
                            <p className="text-xs text-muted-foreground">Adjust the minimum confidence level for detection validity.</p>
                        </div>

                        <div className="pt-4">
                            <Button onClick={handleSave} className="w-full">
                                <Save className="w-4 h-4 mr-2" />
                                Save Policy
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Main Config Area - Checklist */}
                <Card className="lg:col-span-2">
                    <CardHeader>
                        <CardTitle>Restricted Clothing Categories</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-4">
                            <p className="text-sm text-muted-foreground">Select the items that are restricted (not allowed) for this camera zone.</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {clothingItems.map((item) => (
                                    <div
                                        key={item.id}
                                        onClick={() => toggleItem(item.id)}
                                        className={cn(
                                            "flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-all hover:border-destructive/50",
                                            item.required ? "bg-destructive/5 border-destructive" : "bg-card"
                                        )}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={cn("w-10 h-10 rounded-full flex items-center justify-center", item.required ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground")}>
                                                <ShieldCheck className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <h3 className="font-medium">{item.name}</h3>
                                                <p className="text-xs text-muted-foreground">{item.required ? "Restricted (Not Allowed)" : "Allowed / Ignored"}</p>
                                            </div>
                                        </div>
                                        <div className={cn("w-12 h-6 rounded-full relative transition-colors", item.required ? "bg-destructive" : "bg-muted")}>
                                            <div className={cn("absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow-sm", item.required ? "left-7" : "left-1")} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
};

export default DressCode;
