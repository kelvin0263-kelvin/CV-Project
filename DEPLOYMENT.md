# Deployment Guide

This project should not use `npm run dev` in production.

## Recommended production setup

- Build the frontend once with Vite.
- Run the FastAPI backend as a long-running process with Uvicorn.
- Put Nginx in front of both:
  - serve the frontend static files
  - proxy `/api/*` to FastAPI
  - proxy `/ws/*` for camera WebSockets

## Frontend

```bash
cd frontend
npm install
npm run build
```

This creates `frontend/dist`.

The frontend now defaults to the current site origin, so if Nginx serves the site and proxies `/api` and `/ws` on the same domain, you do not need `VITE_API_URL`.

If you deploy the API on a different domain, set:

```bash
VITE_API_URL=https://your-api-domain.com
VITE_WS_URL=wss://your-api-domain.com
```

Then run `npm run build` again.

## Backend

Install dependencies and run migrations before starting the app:

```bash
cd backend
pip install -r requirements.txt
alembic upgrade head
uvicorn main:app --host 127.0.0.1 --port 8000
```

For production, run Uvicorn behind a process manager such as `systemd`, `supervisor`, or Docker.

## Nginx example

Update paths, domain, and SSL settings for your server:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /var/www/cv-project/frontend/dist;
    index index.html;

    client_max_body_size 200M;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600;
    }
}
```

## Notes

- `npm run dev` is only for development.
- If you use HTTPS in production, your WebSocket URLs should also be secure (`wss://`).
- If uploads are large, keep `client_max_body_size` large enough in Nginx.
- Your backend `.env` should use production values for `DATABASE_URL`, `SECRET_KEY`, and other secrets.
