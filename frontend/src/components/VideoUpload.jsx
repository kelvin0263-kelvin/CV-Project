
import React, { useState } from 'react';
import { Upload, FileVideo, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import API_BASE_URL from '@/config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

const VideoUpload = () => {
    const [selectedFile, setSelectedFile] = useState(null);
    const [enableFisheye, setEnableFisheye] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState(null); // 'success', 'error', null
    const [videoUrl, setVideoUrl] = useState('');
    const [message, setMessage] = useState('');

    const handleFileChange = (event) => {
        const file = event.target.files[0];
        if (file && file.type.startsWith('video/')) {
            setSelectedFile(file);
            setVideoUrl('');
            setUploadStatus(null);
        } else {
            alert('Please select a valid video file.');
        }
    };

    const handleUpload = async () => {
        if (!selectedFile) return;

        setIsUploading(true);
        setUploadStatus(null);
        setMessage('Uploading and processing...');

        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('enable_fisheye', enableFisheye);

        try {
            const response = await fetch(`${API_BASE_URL}/api/upload`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                throw new Error('Upload failed');
            }

            const data = await response.json();

            setVideoUrl(data.video_url);
            setUploadStatus('success');
            setMessage(data.message);

        } catch (error) {
            console.error('Error:', error);
            setUploadStatus('error');
            setMessage('Failed to upload/process video. Please ensure backend is running.');
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <h1 className="text-2xl font-bold tracking-tight">Video Analysis Upload</h1>

            <div className="grid gap-6 md:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Upload Video</CardTitle>
                        <CardDescription>
                            Upload a video file for analysis. Optionally enable fisheye correction.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="flex items-center justify-center w-full">
                            <label htmlFor="dropzone-file" className="flex flex-col items-center justify-center w-full h-64 border-2 border-dashed rounded-lg cursor-pointer bg-gray-50 dark:hover:bg-bray-800 dark:bg-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:hover:border-gray-500 dark:hover:bg-gray-600">
                                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                    <CloudUploadIcon className="w-8 h-8 mb-4 text-gray-500 dark:text-gray-400" />
                                    <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                                        <span className="font-semibold">Click to upload</span> or drag and drop
                                    </p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">MP4, AVI, MKV (MAX. 500MB)</p>
                                </div>
                                <input id="dropzone-file" type="file" className="hidden" accept="video/*" onChange={handleFileChange} />
                            </label>
                        </div>

                        {selectedFile && (
                            <div className="flex items-center gap-2 p-2 bg-muted rounded-md text-sm">
                                <FileVideo className="h-4 w-4 text-primary" />
                                <span className="truncate flex-1">{selectedFile.name}</span>
                                <span className="text-muted-foreground">{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB</span>
                            </div>
                        )}

                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="fisheye"
                                checked={enableFisheye}
                                onCheckedChange={setEnableFisheye}
                            />
                            <Label htmlFor="fisheye">Enable Fisheye Correction</Label>
                        </div>
                    </CardContent>
                    <CardFooter>
                        <Button
                            className="w-full"
                            onClick={handleUpload}
                            disabled={!selectedFile || isUploading}
                        >
                            {isUploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {isUploading ? 'Processing...' : 'Start Analysis'}
                        </Button>
                    </CardFooter>
                </Card>

                <div className="space-y-6">
                    {uploadStatus === 'error' && (
                        <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertTitle>Error</AlertTitle>
                            <AlertDescription>{message}</AlertDescription>
                        </Alert>
                    )}

                    {uploadStatus === 'success' && (
                        <Alert className="border-green-500 text-green-700 bg-green-50 dark:bg-green-900/20 dark:text-green-400">
                            <CheckCircle2 className="h-4 w-4" />
                            <AlertTitle>Success</AlertTitle>
                            <AlertDescription>{message}</AlertDescription>
                        </Alert>
                    )}

                    {videoUrl && (
                        <Card>
                            <CardHeader>
                                <CardTitle>Analysis Result</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="aspect-video w-full bg-black rounded-lg overflow-hidden">
                                    <video
                                        controls
                                        className="w-full h-full object-contain"
                                        src={videoUrl}
                                    >
                                        Your browser does not support the video tag.
                                    </video>
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
};

function CloudUploadIcon(props) {
    return (
        <svg
            {...props}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
            <path d="M12 12v9" />
            <path d="m16 16-4-4-4 4" />
        </svg>
    )
}

export default VideoUpload;
