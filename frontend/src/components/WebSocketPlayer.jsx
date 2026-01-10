import { useEffect, useRef, useState } from 'react';
// normally useState and useEffect are used together
// useState store variable (example -> store the download data)
// useEffect process side effects (example -> execute the download action and call useState to update/store the data in the variable)

// setCount(count + 1);     // 1. 页面会变。React 重新运行函数。 ----> count 变成 1，页面刷新。
// countRef.current += 1;   // 2. 页面不会变。但值真的加了 1。 ----> countRef.current 变成 1，页面不会刷新。
// normalVar += 1;          // 3. 页面不会变。 ----> 页面刷新 normalVar 被重新声明，变回了 0

const WebSocketPlayer = ({ wsUrl, className, alt, onStats }) => {
    //useRef is a hook that process reference (variable that does not change over time) -> opposite of useState
    //1.grab a DOM element
    //2. store a value that does not change over time
    const imgRef = useRef(null);
    const wsRef = useRef(null);
    // useState is a hook that process state (variable that changes over time)
    //status is the variable
    // setStatus is the only function to update the variable
    // useState('connecting') is the initial value
    // why not use normal variable? 
    // -> because we want to trigger re-render when status changes
    // if we use normal variable, it will use the old value not the new value
    const [status, setStatus] = useState('connecting');

    // use effect is a hook that process side effects (action that not related to the render)
    // accept 2 parameters
    // 1. callback function -> tell react what to do
    // 2. dependency array  -> tell react when to do (wsUrl changes)
    // return function to clean up resources (close connection)
    // parameter 1 arrow function
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
        // return function to clean up resources (close connection)
        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
        // parameter 2 dependency array
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
