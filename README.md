# MLHub

[![React Badge](https://img.shields.io/badge/-React-61DAFB?style=flat-square&logo=react&logoColor=white)](https://reactjs.org/)
[![Node.js Badge](https://img.shields.io/badge/-Node.js-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express Badge](https://img.shields.io/badge/-Express-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![Docker Badge](https://img.shields.io/badge/-Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

## What is MLHub?

MLHub is a **multi-user Jupyter notebook platform** for machine learning workflows. It provides:

- **Isolated runtime environments**: Each user gets a dedicated notebook container spawned on-demand
- **Secure authentication**: User signup, JWT-based login, and role-based admin controls
- **Admin dashboard**: Monitor active sessions, manage users, and track resource usage
- **Session persistence**: Notebooks persist across session restarts
- **Multi-deployment support**: Run locally with Docker Compose or deploy to Kubernetes

Perfect for teams wanting private, managed notebook environments without exposing raw Jupyter tokens.

## Why Use MLHub?

- 🚀 **Easy setup**: One command to spin up the entire stack on any laptop
- 🔒 **No token exposure**: Session proxy hides Jupyter authentication
- 👥 **Multi-user ready**: Built-in user management and per-user notebook storage
- 📊 **Admin controls**: Monitor resource usage and manage user sessions
- 🐳 **Containerized**: Runs fully in Docker (development) or Kubernetes (production)
- 📝 **Persistent notebooks**: Work isn't lost between sessions

## Quick Start

### 1. Prerequisites

**Required:**
- [Git](https://git-scm.com/downloads)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)

**Recommended:**
- 8 GB RAM minimum (16 GB for comfortable notebook development)
- 10 GB free disk space

### 2. Clone and Build

```bash
# Clone the repository
git clone https://github.com/ren0777/ML-HUB-Platform.git
cd MLHUB

# Build the Jupyter notebook image
docker build -t jupyter-singleuser:dev -f docker/Dockerfile.jupyter .
```

### 3. Start the Stack

```bash
# Start all services (frontend, backend, volumes)
docker compose up --build -d
```

### 3.1 Enable Gemini Code Coach (Optional)

To use the test-first code analysis coach locally, set your Gemini key before starting the stack.

```bash
# Linux/macOS
export GEMINI_API_KEY="your_api_key"
export GEMINI_MODEL="gemini-1.5-flash"

# Windows PowerShell
$env:GEMINI_API_KEY="your_api_key"
$env:GEMINI_MODEL="gemini-1.5-flash"
```

Then restart backend:

```bash
docker compose up --build -d backend
```

### 4. Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:5001

**Default admin credentials:**
```
Username: admin
Password: admin
```

Log in with these credentials, then create additional users via the admin dashboard.

## Usage Examples

### Create a New User (Admin)

1. Log in as admin
2. Click "Admin Dashboard"
3. Click "Create User" and enter username/password
4. New user can now sign up or log in

### Start a Notebook Session

1. Log in as any user
2. Click "Start Session" (or auto-opens on first login)
3. Jupyter Lab opens in an iframe
4. Work as normal—notebooks persist in `/app/notebooks/<username>/`

### Monitor Resources (Admin)

1. Go to Admin Dashboard → "Sessions" tab
2. View active sessions, CPU/memory usage, and session duration
3. Stop any session or delete a user (removes all their notebooks)

### Review User Notebooks (Admin Invigilator)

1. Log in as admin
2. Open "Admin Dashboard"
3. Click "Open users notebook review"
4. Inspect notebook metadata and full notebook cell content on the dedicated review page

### Analyze Code with Code Coach (User)

1. Log in as a user and start a notebook session
2. In workspace sidebar, open the "Code Coach" panel
3. Paste Python code and optional pytest tests
4. Click "Analyze code" to get:
    - test-first verdict (correct/wrong)
    - a quick hint
    - Gemini explanation of wrong part and correction suggestions

### Stop the Stack

```bash
docker compose down
```

**Tip**: Use `docker compose down -v` to reset all local data (users, notebooks, volumes).

## Deployment Modes

### Docker Compose (Default, Recommended for Local Development)

```bash
docker compose up --build -d
```

Runs all services locally: frontend, backend, and spawned notebook containers share the Docker network.

### Kubernetes (Optional, for Cluster Deployment)

This repo includes Kubernetes manifests in the `k8s/` folder.

**Requirements:**
- Kubernetes cluster (Docker Desktop K8s, EKS, GKE, etc.)
- Nginx Ingress Controller

**Deploy:**

```bash
# Build images
docker build -t jupyter-api:dev -f docker/Dockerfile.api .
docker build -t jupyter-frontend:dev -f docker/Dockerfile.frontend .
docker build -t jupyter-singleuser:dev -f docker/Dockerfile.jupyter .

# Apply manifests
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/backend-rbac.yaml
kubectl apply -f k8s/backend-deploy.yaml
kubectl apply -f k8s/frontend-deploy.yaml
kubectl apply -f k8s/ingress.yaml

# Access via ingress (add colab.local to /etc/hosts pointing to ingress IP)
# http://colab.local
```

## Architecture

```
┌─────────────────────────┐
│   Browser (React UI)    │
│  http://localhost:3000  │
└────────────┬────────────┘
             │
    ┌────────▼────────┐
    │ Nginx (Reverse  │
    │     Proxy)      │
    └────────┬────────┘
             │
    ┌────────┴────────────┬──────────────┐
    │                     │              │
┌───▼──────┐      ┌──────▼────┐   ┌─────▼─────────┐
│ Frontend  │      │  Backend  │   │   Notebook    │
│  (React)  │      │ (Express) │   │  (Jupyter Lab)│
│  Nginx    │      │  +Auth    │   │  (per-user)   │
└───┬──────┘      └──────┬────┘   └─────┬─────────┘
    │                    │              │
    └────────┬───────────┴──────────────┘
             │
      ┌──────▼──────────┐
      │  Docker Volumes │
      │ /notebooks/...  │
      │ /users.json     │
      └─────────────────┘
```

**Components:**
- **Frontend**: React SPA served by Nginx on port 80
- **Backend**: Express.js API on port 5000, handles auth, session mgmt, and Jupyter proxying
- **Notebook containers**: Spawned on-demand per user session, run Jupyter Lab
- **Storage**: Docker volumes persist user notebooks and auth data

## Project Structure

```
.
├── frontend/
│   ├── src/
│   │   ├── App.jsx           # Main router and layout
│   │   ├── Login.jsx         # Auth UI
│   │   └── admin/
│   │       └── AdminDashboard.jsx
│   ├── public/               # Static assets
│   └── package.json
├── server/
│   ├── index.js              # Express app, API routes
│   ├── users.json            # User database (dev only)
│   └── package.json
├── docker/
│   ├── Dockerfile.jupyter    # Notebook runtime
│   ├── Dockerfile.api        # Backend for k8s
│   ├── Dockerfile.frontend   # Frontend for k8s
│   └── nginx.conf            # Reverse proxy config
├── k8s/                      # Kubernetes manifests
├── docker-compose.yml        # Local orchestration
└── README.md                 # This file
```

## Common Commands

| Command | Purpose |
|---------|---------|
| `docker compose up -d` | Start all services in background |
| `docker compose down` | Stop all services |
| `docker compose logs -f` | Stream logs from all services |
| `docker compose ps` | Show running containers |
| `docker compose restart backend` | Restart backend (useful after code changes) |
| `docker compose down -v` | Stop and remove all volumes (reset data) |

## Troubleshooting

**Port 3000 or 5001 already in use?**
```bash
docker compose down
docker compose up --build -d
```

**Docker command fails?**
- Ensure Docker Desktop is running
- On Linux, check Docker daemon: `sudo systemctl start docker`

**Notebook session won't start?**
```bash
docker build -t jupyter-singleuser:dev -f docker/Dockerfile.jupyter .
docker compose restart backend
```

**Changes not reflecting in UI/API?**
```bash
docker compose up --build -d
```

For additional help, check the project's GitHub Issues or open a new one with:
- OS and Docker version
- Error messages from logs (`docker compose logs`)
- Steps to reproduce

## Getting Help

- **Issues & Bugs**: [GitHub Issues]
- **Local logs**: `docker compose logs -f <service>`
- **Kubernetes logs**: `kubectl logs -n jhub <pod>`

## Contributing

We welcome contributions! To get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/my-feature`
3. **Make your changes** and test locally
4. **Commit with clear messages**: `git commit -m "Add new feature"`
5. **Push to your fork**: `git push origin feature/my-feature`
6. **Open a Pull Request** with a description of changes

For significant changes, please open an issue first to discuss the approach.

**Development Setup:**
```bash
# Start with local docker compose
docker compose up -d

# Frontend code reloads on save (via React dev server)
cd frontend && npm run start

# Backend code requires restart
docker compose restart backend
```

## License

This project is licensed under the [MIT License](LICENSE).

## Maintainers

This project is maintained by the ML engineering team. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

**Ready to get started?** Run the Quick Start steps above, or check the [Kubernetes deployment guide](k8s/README.md) for cluster setup.
