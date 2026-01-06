import React, { useEffect, useRef, useState } from 'react';

const WebSocketPlayer = ({ wsUrl, className, alt, onStats }) => {
    const imgRef = useRef(null);
    const wsRef = useRef(null);
    const [status, setStatus] = useState('connecting');

    useEffect(() => {
        if (!wsUrl) return;

        // Close existing connection if any
        if (wsRef.current) {
            wsRef.current.close();
        }

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log(`Connected to ${wsUrl}`);
            setStatus('connected');
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.image && imgRef.current) {
                    imgRef.current.src = `data:image/jpeg;base64,${data.image}`;
                }
                if (data.fps !== undefined && onStats) {
                    onStats({ fps: data.fps });
                }
            } catch (e) {
                console.error("Error parsing WS message", e);
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            setStatus('error');
        };

        ws.onclose = () => {
            console.log("WebSocket closed");
            setStatus('disconnected');
        };

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [wsUrl]);

    return (
        <div className={`relative bg-black flex items-center justify-center overflow-hidden ${className}`}>
            <img
                ref={imgRef}
                className="w-full h-full object-contain"
                alt={alt}
            />
            {status !== 'connected' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-xs">
                    {status === 'connecting' && "Connecting..."}
                    {status === 'error' && "Connection Error"}
                    {status === 'disconnected' && "Offline"}
                </div>
            )}
        </div>
    );
};

export default WebSocketPlayer;
