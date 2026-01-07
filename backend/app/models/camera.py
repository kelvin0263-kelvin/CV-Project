from pydantic import BaseModel

class CameraSource(BaseModel):
    id: str
    name: str
    location: str
    type: str 
    status: str
    mode: str
    ws_url: str
    resolution: str
    fps: int
    enabled: bool
    image: str
