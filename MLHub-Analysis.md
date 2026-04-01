# MLHub Project Analysis

## 1. Main Purpose & Functionality

**MLHub** is a Docker-based web platform that enables users to launch isolated, per-session Jupyter notebook environments with authentication and admin controls. Each user gets:
- Isolated notebook container or Kubernetes pod sessions
- Private runtime environment (independent compute, file system per session)
- Web UI for login/signup and notebook access
- Admin dashboard for user management and resource monitoring

**Key Goals:**
- Provide secure, multi-user Jupyter notebook hosting
- Automatic notebook session lifecycle management
- Resource tracking and admin controls
- Both Docker and Kubernetes deployment support

---

## 2. Frontend Architecture (React)

### Framework & Build
- **Framework:** React 18.2.0 with React Router v6
- **Build Tool:** `react-app-rewired` (wraps Create React App for custom webpack config)
- **Proxy:** Proxies `/api` requests to backend at `http://backend:5000` during development
- **Deployment:** Multi-stage Docker build → React app compiled to static artifacts → Served by Nginx

### Key Components

| Component | Purpose |
|-----------|---------|
| `App.jsx` | Root component; handles auth state, SSE events, JWT decoding, routing |
| `Login.jsx` | Sign up/login form; sends credentials to `/api/auth/signup` or `/api/auth/login` |
| `AdminDashboard.jsx` | Admin-only view for user management, analytics, session control |

### Authentication Flow
1. User logs in/signs up with username + password
2. Backend returns JWT token (7-day expiry, includes username & role)
3. Frontend stores token in `localStorage`
4. All API calls include token in `Authorization: Bearer <token>` header
5. Token decoded (client-side) using `jwt-decode` to extract role & username

### Real-time Event Handling
- Frontend opens Server-Sent Events (SSE) connection via `/api/events?token=<jwt>`
- Backend pushes events: `user_deleted`, `session_stopped`, `session_started`
- UI reactively updates when events arrive (e.g., session stopped by admin)

### Dependencies
- `react / react-dom`: UI rendering
- `react-router-dom`: Routing
- `jwt-decode`: Client-side token parsing (no verification)
- `react-app-rewired`: Custom webpack config without ejecting
- Polyfills: `browserify-zlib`, `crypto-browserify`, `stream-browserify` (Node.js APIs for browser)

---

## 3. Backend Architecture (Node.js + Express)

### Framework & Design
- **Runtime:** Node.js 18 (Alpine)
- **Web Server:** Express.js 4.18.2
- **Orchestration Support:** Kubernetes API client + Docker API client (one active at runtime)
- **Deployment:** Express server on port 5000; proxied to port 80 via Nginx

### Key APIs

#### Authentication
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/auth/signup` | POST | Public | Create new user (hashed password stored, JWT returned) |
| `/auth/login` | POST | Public | Verify credentials, return JWT |
| `/events` | GET (SSE) | JWT | Stream server events to connected clients |

#### Session Management
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/session/new` | POST | JWT | Create or restore user's notebook session |
| `/session/stop` | POST | JWT | Stop a notebook session (delete container/pod) |

#### Admin APIs
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/admin/users` | GET | Admin | List all users with roles |
| `/admin/sessions` | GET | Admin | List all active sessions |
| `/admin/analytics` | GET | Admin | Host memory, storage, per-session resource limits |
| `/admin/user-usage` | GET | Admin | Per-user resource consumption (memory, storage) |
| `/admin/user` | POST | Admin | Create new user (with role) |
| `/admin/user/:username` | DELETE | Admin | Delete user & their notebooks |

#### Notebook Proxying
- Nginx routes `/jupyter/<sessionId>/*` → Backend
- Backend proxies to Jupyter container/pod via HTTP
- Jupyter Lab runs at `http://<container>:8888` (Docker) or `http://<service>.<namespace>.svc.cluster.local:8888` (K8s)

### Authentication & Authorization
- **Signup:** Username must be unique; password hashed with SHA256 + random salt
- **JWT Generation:** `jwt.sign({ username, role }, JWT_SECRET, { expiresIn: '7d' })`
- **Admin Middleware:** `requiresAdmin()` verifies JWT and checks `role === 'admin'`
- **Default Admin:** If `users.json` empty, auto-creates `admin:admin` on startup

### Session & Notebook Lifecycle
1. **Session Creation** (`/session/new`)
   - Check for existing session for user
   - If found, verify container/pod still running; if dead, delete from map
   - Else create new notebook container/deployment
   - Wait up to 60s for Jupyter to be ready (`GET /lab` endpoint)
   - Store session in in-memory map with session token as key

2. **Notebook Resources**
   - **Docker mode:** Creates Docker container + volume (mounted to `/home/jovyan/work`)
   - **Kubernetes mode:** Creates Deployment + Service + PersistentVolumeClaim
   - **Resource Limits:** Via env vars (CPU: 250m request → 1 limit; memory: 512Mi request → 2Gi limit)

3. **Session Cleanup** (`/session/stop`)
   - Only user or admin can stop
   - Deletes container/deployment/service
   - Notifies other admins + user via SSE

### User & Session Storage
- **In-Memory Maps:** `users` Map, `sessions` Map (ephemeral per process restart)
- **Persistent User File:** `users.json` (JSON array of `[username, { password, role }]` tuples)
- **User Directories:** `notebooks/<username>/` for storing user's notebook files
- **Data Volumes:** Docker volumes or K8s PVCs persist notebooks across session restarts

---

## 4. Docker Setup & Deployment

### Services (docker-compose.yml)

| Service | Image | Ports | Volumes | Purpose |
|---------|-------|-------|---------|---------|
| `frontend` | Custom (node:18 → nginx) | 3000:80 | Frontend node_modules | React UI server |
| `backend` | Custom (node:18) | 5001:5000 | Data, users, notebooks, docker.sock | Express API + session manager |
| Jupyter (spawn on demand) | `jupyter-singleuser:dev` | N/A | Volume (mount to `/home/jovyan/work`) | User's notebook environment |

### Dockerfiles

#### Dockerfile.notebook (Jupyter runtime)
```dockerfile
FROM jupyter/scipy-notebook:latest  # Pre-loaded with pandas, numpy, matplotlib, scikit-learn
RUN pip install scikit-learn pandas numpy matplotlib seaborn flask
COPY docker/mlhub-start.sh /usr/local/bin/mlhub-start.sh
EXPOSE 8888
CMD ["/usr/local/bin/mlhub-start.sh"]
```
- **Base:** Jupyter's official scipy image (includes Python 3.x)
- **Pre-installed ML libs:** scikit-learn, pandas, numpy, matplotlib, seaborn, flask
- **Startup Script:** `mlhub-start.sh` launches JupyterLab

#### Dockerfile.api (Backend)
```dockerfile
FROM node:18-alpine
COPY server/package.json package-lock.json ./
RUN npm install --production
COPY server/ ./
EXPOSE 5000
CMD ["node", "index.js"]
```

#### Dockerfile.frontend (React UI)
```dockerfile
# Build stage
FROM node:18-alpine as build
COPY frontend/ ./
RUN npm install && npm run build

# Serve stage
FROM nginx:stable-alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Nginx Reverse Proxy (`docker/nginx.conf`)
```
Location → Behavior
/          → React SPA (try_files $uri /index.html for client routing)
/api/...   → Proxied to backend:5000/...
/jupyter/  → Proxied to backend:5000/jupyter/... (Jupyter)
/<sessionId>/...  → Regex match → Proxied to backend:5000/jupyter/<sessionId>/... (Jupyter Lab assets)
```

### Environment Variables (backend container)
```
JWT_SECRET=a-very-secure-secret-for-dev
NOTEBOOK_IMAGE=jupyter-singleuser:dev
NOTEBOOK_PORT=8888
NOTEBOOK_BASE_URL_PREFIX=/jupyter
DOCKER_NOTEBOOK_NETWORK=colab-clone_default
DOCKER_SOCKET_PATH=/var/run/docker.sock
```

### Deployment Modes
- **Docker (Default):** Backend spawns notebook containers via Docker daemon
- **Kubernetes:** If `KUBERNETES_SERVICE_HOST` env var present, backend creates Deployments + Services + PVCs

---

## 5. Key Dependencies & Versions

### Frontend (package.json)
```json
{
  "react": "18.2.0",
  "react-dom": "18.2.0",
  "react-router-dom": "^6.22.3",
  "jwt-decode": "^4.0.0",
  "react-app-rewired": "^2.2.1",
  "react-scripts": "5.0.1"
}
```

### Backend (package.json)
```json
{
  "express": "^4.18.2",
  "jsonwebtoken": "^9.0.2",
  "http-proxy-middleware": "^2.0.6",
  "dockerode": "^4.0.9",
  "@kubernetes/client-node": "^0.21.0",
  "node-fetch": "^2.6.7"
}
```

### Notebook Image (requirements.txt)
```
numpy, pandas, scikit-learn, matplotlib, jupyterlab, notebook
```

---

## 6. Notebook Management & Serving

### Notebook File Location
- **Persistent storage:** Docker volume or K8s PVC mounted to `/home/jovyan/work` inside Jupyter container
- **Host-side path:** `notebooks/<username>/` directory (Docker) or PVC (K8s)
- **Per-session:** Users can upload/create `.ipynb` files; persist across session restarts if same volume reused

### Session Lifecycle & Reuse
1. User logs in → frontend calls `POST /session/new`
2. Backend checks if user already has a session in `sessions` map
3. If found and running, reuses it; if dead, removes from map and creates new
4. If not found, creates new container/pod
5. Container starts with entrypoint: `/usr/local/bin/mlhub-start.sh`
6. Jupyter Lab launches at `http://<container>:8888` or `http://<service>.<ns>.svc.cluster.local:8888`
7. Frontend opens iframe to `/jupyter/<sessionId>/lab`
8. Nginx proxies requests to backend → backend proxies to Jupyter

### Jupyter Lab Base URLs
- **Internal (container):** `http://localhost:8888/`
- **Proxy base URL:** `/jupyter/<sessionId>/` (set via `NOTEBOOK_BASE_URL` env var)
- **Public URL:** `http://localhost:3000/jupyter/<sessionId>/lab`

---

## 7. Admin Dashboard Features

### Accessed by Admin Users at `http://localhost:3000/admin`

#### User Management
- **List Users:** Display all users with roles
- **Create User:** Form to add new user (username, password, role)
- **Delete User:** Remove user account (prevents admins from deleting themselves)
- Deletion cascades: user directory & active sessions terminated

#### Session Monitoring
- **Active Sessions:** Show all running notebook sessions (user, container name, creation time)
- **Stop Session:** Admin can forcibly stop any user's session (Docker: remove container; K8s: delete deployment)
- **Event Notifications:** Real-time via SSE (session started/stopped, user added/removed)

#### Resource Analytics
- **Host Memory:** Total, used, free (from `os.totalmem() / os.freemem()`)
- **Process Memory:** Node.js heap, RSS, external buffers
- **Session Capacity:** Active session count, per-session memory limit, reserved bytes
- **Storage Usage:** Filesystem stats for data directory
- **Per-User Metrics:** Individual memory consumption (via Docker stats API), storage
- **Refresh Rate:** Auto-updates every 15 seconds via `GET /admin/analytics` & `GET /admin/user-usage`

#### Dashboard Rendering
- Usage bars showing % utilization (red/orange tone for high usage)
- Formatted bytes (B, KB, MB, GB, TB)
- User list with live status (active session or idle)

---

## 8. Authentication & User Management Flow

### Signup Flow
```
User Browser → POST /api/auth/signup { username, password }
             ↓
Backend:
  1. Check username not in users.json
  2. Hash password (SHA256 + random salt)
  3. Create user object { password: hashed, role: "user" (or "admin" if username === "admin") }
  4. Append to users.json
  5. Create /notebooks/<username>/ directory
  6. Sign JWT with { username, role } (7-day expiry)
  7. Return { token: "<jwt>" }
             ↓
Frontend:
  1. Store token in localStorage
  2. Decode token → extract username & role
  3. If role === "admin", show admin dashboard link
  4. Call POST /session/new to start notebook session
  5. Render notebook iframe
```

### Login Flow
```
User Browser → POST /api/auth/login { username, password }
             ↓
Backend:
  1. Look up user from users.json
  2. Verify password (hash with stored salt)
  3. Sign JWT { username, role }
  4. Return { token: "<jwt>" }
             ↓
Frontend:
  (Same as signup step 2 onwards)
```

### JWT Token Structure
```javascript
Header: { alg: "HS256", typ: "JWT" }
Payload: { username: "john_doe", role: "user|admin", iat: <timestamp>, exp: <7days> }
Signature: HMAC-SHA256(secret)
```

### Authorization Patterns
- **Public endpoints:** `/auth/signup`, `/auth/login`
- **User endpoints:** `/session/new`, `/session/stop` (require valid JWT; users can only manage own sessions unless admin)
- **Admin endpoints:** `/admin/*` (require JWT + `role === 'admin'`)
- **Event stream:** `/events` (requires JWT, broadcasts role-specific or user-specific events)

### User Roles
- **Admin:** Can create/delete users, view all sessions, stop any session, view analytics
- **User:** Can create/stop own session, view own notebook

---

## Quick Reference: Key Technical Decisions

| Topic | Decision | Why |
|-------|----------|-----|
| Session State | In-memory Map + persistent users.json | Fast lookups; users persist restarts; sessions ephemeral (acceptable) |
| Password Hashing | SHA256 + salt (custom) | Simple; not bcrypt, so lower security but faster for dev |
| Auth Method | JWT (7-day expiry) | Stateless; scales horizontally |
| Notebook Container | Docker (default) or K8s Deployment | Flexible local dev (Docker) + production scaling (K8s) |
| Notebook Volume | Docker volume / K8s PVC | Persist user files across session reuse |
| Real-time Events | Server-Sent Events (SSE) | Simple; works behind Nginx; avoids WebSocket complexity |
| Frontend Routing | React Router (client-side) | SPA; fast navigation; JWT auth means no server-side sessions needed |
| Reverse Proxy | Nginx | Simple; routes frontend SPA + API + Jupyter sessions in one place |

