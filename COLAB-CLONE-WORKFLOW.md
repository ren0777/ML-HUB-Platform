# MLHub - Complete Application Workflow

## Overview

This document describes the complete user workflow and system architecture for the MLHub application, a web-based environment for automated machine learning model deployment.

---

## 🎯 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER BROWSER                            │
│                    http://localhost:3000                        │
│                        React Frontend                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                ┌──────────▼──────────┐
                │   Nginx Proxy       │
                │   Port: 80          │
                │                     │
                │  Routes:            │
                │  /api/* → Backend   │
                │  /jupyter/* → Lab   │
                └──────────┬──────────┘
                           │
          ┌────────────────┴────────────────┐
          │                                 │
   ┌──────▼────────┐              ┌────────▼──────────┐
   │ Backend API   │              │  Jupyter Server   │
   │ Node.js/Express│             │  JupyterLab       │
   │ Port: 5000    │              │  Port: 8888       │
   │               │◄─Proxy──────►│                   │
   │ • Auth (JWT)  │  sessions    │ • Notebook Engine │
   │ • Sessions    │              │ • Python/Kernel   │
   │ • User Mgmt   │              │ • File System     │
   └───────┬───────┘              └─────────┬─────────┘
           │                                │
           │                                │
      ┌────▼────┐                    ┌──────▼─────┐
      │users.json│                    │ /notebooks/│
      │ Storage  │                    │  /user1/   │
      └──────────┘                    │  /user2/   │
                                      └────────────┘
```

---

## 📋 User Workflows

### 1️⃣ **New User Registration Flow**

```
┌───────────────────────────────────────────────────────────────┐
│ STEP 1: User Opens Application                               │
└───────────────────────────────────────────────────────────────┘
                            ↓
    Browser navigates to: http://localhost:3000
                            ↓
    React App loads (Login.jsx component)
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 2: User Clicks "Sign Up"                                │
└───────────────────────────────────────────────────────────────┘
                            ↓
    Displays signup form:
    - Username field
    - Password field
    - Confirm Password field
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 3: User Enters Credentials                              │
└───────────────────────────────────────────────────────────────┘
                            ↓
    User fills form:
    Username: "john_doe"
    Password: "secure123"
                            ↓
    Clicks "Sign Up" button
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 4: Frontend Sends Request                               │
└───────────────────────────────────────────────────────────────┘
                            ↓
    POST /api/auth/signup
    Body: {
      "username": "john_doe",
      "password": "secure123"
    }
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 5: Backend Processes Signup (server/index.js)           │
└───────────────────────────────────────────────────────────────┘
                            ↓
    1. Check if username exists
       ├─ YES → Return 400 "User already exists"
       └─ NO → Continue
                            ↓
    2. Hash password with bcrypt (10 rounds)
       password_hash = bcrypt.hash("secure123", 10)
                            ↓
    3. Create user object:
       {
         password: "hashed_password",
         role: "user"  // or "admin" if username is "admin"
       }
                            ↓
    4. Save to users Map and users.json file
                            ↓
    5. Create user's notebook directory:
       /notebooks/john_doe/
                            ↓
    6. Generate JWT token:
       jwt.sign({
         username: "john_doe",
         role: "user"
       }, JWT_SECRET, { expiresIn: '7d' })
                            ↓
    7. Return response:
       { "token": "eyJhbGciOiJIUzI1..." }
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 6: Frontend Receives Token                              │
└───────────────────────────────────────────────────────────────┘
                            ↓
    1. Store token in localStorage
    2. Decode token to get user role
    3. Create Jupyter session
    4. Redirect to notebook interface
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 7: User is Logged In ✅                                  │
└───────────────────────────────────────────────────────────────┘
```

---

### 2️⃣ **Existing User Login Flow**

```
┌───────────────────────────────────────────────────────────────┐
│ STEP 1: User Opens Application                               │
└───────────────────────────────────────────────────────────────┘
                            ↓
    Browser: http://localhost:3000
    React displays Login.jsx
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 2: User Enters Credentials                              │
└───────────────────────────────────────────────────────────────┘
                            ↓
    Username: "john_doe"
    Password: "secure123"
                            ↓
    Clicks "Login" button
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 3: Frontend Sends Request                               │
└───────────────────────────────────────────────────────────────┘
                            ↓
    POST /api/auth/login
    Body: {
      "username": "john_doe",
      "password": "secure123"
    }
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 4: Backend Validates Credentials                        │
└───────────────────────────────────────────────────────────────┘
                            ↓
    1. Check if user exists in Map
       ├─ NO → Return 401 "Invalid credentials"
       └─ YES → Continue
                            ↓
    2. Compare password with bcrypt:
       bcrypt.compare("secure123", stored_hash)
       ├─ FALSE → Return 401 "Invalid credentials"
       └─ TRUE → Continue
                            ↓
    3. Generate JWT token with role
                            ↓
    4. Return: { "token": "eyJhbGciOiJIUzI1..." }
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 5: Frontend Processes Login                             │
└───────────────────────────────────────────────────────────────┘
                            ↓
    1. Store token in localStorage
    2. Decode token → get username & role
    3. Set token state in App component
    4. Create Jupyter session automatically
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 6: User Logged In Successfully ✅                        │
└───────────────────────────────────────────────────────────────┘
```

---

### 3️⃣ **Jupyter Notebook Session Creation**

```
┌───────────────────────────────────────────────────────────────┐
│ User Logged In → Create Session                              │
└───────────────────────────────────────────────────────────────┘
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 1: Frontend Calls createSession()                       │
└───────────────────────────────────────────────────────────────┘
                            ↓
    POST /api/sessions/create
    Headers: {
      Authorization: "Bearer <JWT_TOKEN>"
    }
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 2: Backend Validates JWT Token                          │
└───────────────────────────────────────────────────────────────┘
                            ↓
    jwt.verify(token, JWT_SECRET)
    → Extract username from token
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 3: Backend Generates Unique Session Token               │
└───────────────────────────────────────────────────────────────┘
                            ↓
    sessionToken = crypto.randomBytes(32).toString('hex')
                            ↓
    Store in sessions Map:
    sessions.set(sessionToken, {
      username: "john_doe",
      createdAt: Date.now()
    })
                            ↓
    Return: { sessionToken: "a1b2c3d4..." }
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 4: Frontend Receives Session Token                      │
└───────────────────────────────────────────────────────────────┘
                            ↓
    setSessionToken("a1b2c3d4...")
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 5: Frontend Displays Jupyter Interface                  │
└───────────────────────────────────────────────────────────────┘
                            ↓
    <iframe
      src="/jupyter/lab?token=a1b2c3d4..."
      width="100%"
      height="100%"
    />
                            ↓
    Nginx proxies request to Jupyter server
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 6: Jupyter Lab Loads in iframe ✅                        │
└───────────────────────────────────────────────────────────────┘
    User can now:
    • Create notebooks
    • Run Python code
    • Install packages
    • Upload/download files
```

---

### 4️⃣ **Working with Jupyter Notebooks**

```
┌───────────────────────────────────────────────────────────────┐
│ User Has Active Jupyter Session                              │
└───────────────────────────────────────────────────────────────┘
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ ACTION 1: Create New Notebook                                │
└───────────────────────────────────────────────────────────────┘
                            ↓
    User clicks "New" → "Notebook" in Jupyter UI
                            ↓
    Jupyter creates: /notebooks/john_doe/Untitled.ipynb
                            ↓
    Starts Python kernel
                            ↓
    User can write Python code in cells
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ ACTION 2: Execute Code                                        │
└───────────────────────────────────────────────────────────────┘
                            ↓
    User types in cell:
    ```python
    import pandas as pd
   print("Hello from MLHub!")
    ```
                            ↓
    User presses Shift+Enter
                            ↓
    Jupyter sends code to Python kernel
                            ↓
    Kernel executes code
                            ↓
    Output displayed in notebook:
   "Hello from MLHub!"
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ ACTION 3: Save Notebook                                       │
└───────────────────────────────────────────────────────────────┘
                            ↓
    User clicks Save or Ctrl+S
                            ↓
    Jupyter saves to: /notebooks/john_doe/my_analysis.ipynb
                            ↓
    Files persist in Docker volume
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ ACTION 4: Install Packages                                    │
└───────────────────────────────────────────────────────────────┘
                            ↓
    User runs in cell:
    !pip install seaborn
                            ↓
    Package installed in Jupyter container
                            ↓
    Available for use in notebook
```

---

### 5️⃣ **Admin User Management Flow**

```
┌───────────────────────────────────────────────────────────────┐
│ Admin Logs In with Admin Credentials                         │
└───────────────────────────────────────────────────────────────┘
                            ↓
    Username: "admin"
    Password: "admin"
                            ↓
    JWT token includes: { role: "admin" }
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 1: Admin Navigates to Dashboard                         │
└───────────────────────────────────────────────────────────────┘
                            ↓
    React Router: /admin
                            ↓
    Loads AdminDashboard.jsx component
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 2: Fetch All Users                                      │
└───────────────────────────────────────────────────────────────┘
                            ↓
    GET /api/admin/users
    Headers: { Authorization: "Bearer <ADMIN_TOKEN>" }
                            ↓
    Backend checks:
    1. Token valid? ✓
    2. Role === "admin"? ✓
                            ↓
    Returns list of users:
    [
      { username: "john_doe", role: "user" },
      { username: "jane_smith", role: "user" },
      { username: "admin", role: "admin" }
    ]
                            ↓
    Dashboard displays user list
                            ↓
┌───────────────────────────────────────────────────────────────┐
│ STEP 3: Admin Can Manage Users                               │
└───────────────────────────────────────────────────────────────┘
                            ↓
    Available Actions:
                            ↓
    ┌─────────────────────────────────────┐
    │ DELETE User                         │
    └─────────────────────────────────────┘
                ↓
    DELETE /api/admin/users/:username
                ↓
    Backend:
    1. Verify admin token ✓
    2. Remove from users Map
    3. Delete from users.json
    4. Delete user's notebook directory
    5. Return: { message: "User deleted" }
                            ↓
    ┌─────────────────────────────────────┐
    │ VIEW Active Sessions                │
    └─────────────────────────────────────┘
                ↓
    GET /api/admin/sessions
                ↓
    Backend returns:
    [
      { sessionToken: "abc123", username: "john_doe", createdAt: 1234567890 }
    ]
                            ↓
    ┌─────────────────────────────────────┐
    │ TERMINATE Session                   │
    └─────────────────────────────────────┘
                ↓
    DELETE /api/admin/sessions/:token
                ↓
    Backend removes session from Map
```

---

## 🔐 Security & Authentication Flow

```
┌───────────────────────────────────────────────────────────────┐
│                    JWT Token Lifecycle                        │
└───────────────────────────────────────────────────────────────┘

1. USER LOGS IN
   ↓
   Backend generates JWT:
   jwt.sign({ username, role }, JWT_SECRET, { expiresIn: '7d' })
   ↓
   Token structure:
   {
     "header": {
       "alg": "HS256",
       "typ": "JWT"
     },
     "payload": {
       "username": "john_doe",
       "role": "user",
       "iat": 1234567890,
       "exp": 1235172690
     },
     "signature": "..."
   }
   ↓

2. TOKEN STORAGE
   ↓
   Frontend stores in: localStorage.setItem('token', token)
   ↓

3. AUTHENTICATED REQUESTS
   ↓
   Every API call includes:
   Headers: { Authorization: "Bearer <token>" }
   ↓

4. TOKEN VALIDATION
   ↓
   Backend middleware:
   - Extracts token from header
   - Verifies signature with JWT_SECRET
   - Checks expiration
   - Extracts username & role
   ↓

5. AUTHORIZATION
   ↓
   For admin-only routes:
   - Check if role === "admin"
   - Return 403 if not admin
   ↓

6. SESSION TOKENS (Separate System)
   ↓
   Purpose: Proxy Jupyter access without exposing Jupyter token
   ↓
   Flow:
   - User has valid JWT
   - Backend creates unique session token
   - Frontend uses session token for Jupyter iframe
   - Backend proxies requests to Jupyter with real token
   ↓
   Security benefit:
   - Real Jupyter token never exposed to frontend
   - Session tokens can be revoked independently
```

---

## 🔄 Request Flow Examples

### Example 1: Creating a Notebook

```
USER ACTION: Click "New Notebook" in Jupyter UI
                ↓
┌─────────────────────────────────────────────────┐
│ 1. Browser → Nginx                              │
└─────────────────────────────────────────────────┘
    Request: GET /jupyter/lab?token=sessionToken
                ↓
┌─────────────────────────────────────────────────┐
│ 2. Nginx → Backend (Proxy Middleware)          │
└─────────────────────────────────────────────────┘
    Nginx forwards to: /api/jupyter/*
                ↓
┌─────────────────────────────────────────────────┐
│ 3. Backend Validates Session                    │
└─────────────────────────────────────────────────┘
    - Look up session token in sessions Map
    - Get associated username
    - Inject real Jupyter token
                ↓
┌─────────────────────────────────────────────────┐
│ 4. Backend → Jupyter Server                     │
└─────────────────────────────────────────────────┘
    Proxied request with real token
                ↓
┌─────────────────────────────────────────────────┐
│ 5. Jupyter Creates Notebook                     │
└─────────────────────────────────────────────────┘
    File: /notebooks/john_doe/Untitled.ipynb
                ↓
┌─────────────────────────────────────────────────┐
│ 6. Response → Backend → Nginx → Browser        │
└─────────────────────────────────────────────────┘
    Notebook interface displayed
```

### Example 2: Admin Deleting User

```
ADMIN ACTION: Click "Delete" on user "john_doe"
                ↓
┌─────────────────────────────────────────────────┐
│ 1. Browser → Frontend (AdminDashboard)         │
└─────────────────────────────────────────────────┘
    Confirm deletion dialog
                ↓
┌─────────────────────────────────────────────────┐
│ 2. Frontend → Backend                           │
└─────────────────────────────────────────────────┘
    DELETE /api/admin/users/john_doe
    Headers: { Authorization: "Bearer <admin_token>" }
                ↓
┌─────────────────────────────────────────────────┐
│ 3. Backend Validates Admin Token                │
└─────────────────────────────────────────────────┘
    requiresAdmin() middleware:
    - Verify JWT signature
    - Check role === "admin"
                ↓
┌─────────────────────────────────────────────────┐
│ 4. Backend Deletes User                         │
└─────────────────────────────────────────────────┘
    1. Remove from users Map
    2. Save users.json (without john_doe)
    3. Delete /notebooks/john_doe/ directory
    4. Terminate active sessions
                ↓
┌─────────────────────────────────────────────────┐
│ 5. Response → Frontend                          │
└─────────────────────────────────────────────────┘
    { message: "User deleted successfully" }
                ↓
    Frontend refreshes user list
```

---

## 📁 File System Structure

```
/mlhub/
├── notebooks/                    # User notebook storage
│   ├── admin/                   # Admin's notebooks
│   │   └── *.ipynb
│   ├── john_doe/                # John's notebooks
│   │   ├── analysis.ipynb
│   │   └── ml_model.ipynb
│   └── jane_smith/              # Jane's notebooks
│       └── data_viz.ipynb
│
├── server/
│   ├── index.js                 # Main backend server
│   └── users.json               # User database
│       Format:
│       [
│         ["admin", { password: "hash", role: "admin" }],
│         ["john_doe", { password: "hash", role: "user" }]
│       ]
│
└── frontend/
    └── src/
        ├── App.jsx              # Main app component
        ├── Login.jsx            # Login/signup UI
        └── admin/
            └── AdminDashboard.jsx  # Admin panel
```

---

## 🔄 Data Persistence

```
┌─────────────────────────────────────────────────────────────┐
│                   WHAT GETS SAVED WHERE                     │
└─────────────────────────────────────────────────────────────┘

📝 User Credentials
   ↓
   Location: server/users.json
   Format: Array of [username, { password: hash, role: string }]
   Persistence: File system (survives container restart)

📓 Jupyter Notebooks
   ↓
   Location: notebooks/<username>/*.ipynb
   Format: JSON (Jupyter notebook format)
   Persistence: Docker volume (mount point)

🔐 JWT Tokens
   ↓
   Location: Browser localStorage
   Format: String (JWT)
   Persistence: Browser storage (survives page refresh)

🎫 Session Tokens
   ↓
   Location: Backend memory (sessions Map)
   Format: Map(sessionToken → { username, createdAt })
   Persistence: Memory only (lost on server restart)
   Note: Users need to re-create session after restart
```

---

## 🚦 Port Mapping

```
Service         Internal Port    External Port    URL
─────────────────────────────────────────────────────────────
Frontend        80               3000            http://localhost:3000
Backend         5000             5001            http://localhost:5001
Jupyter         8888             9998            http://localhost:9998
```

---

## 🔗 API Endpoints Summary

### Authentication
```
POST   /api/auth/signup         Create new user
POST   /api/auth/login          Login existing user
```

### Sessions
```
POST   /api/sessions/create     Create Jupyter session (requires JWT)
DELETE /api/sessions/:token     Delete session (requires JWT)
```

### Admin (Requires admin role)
```
GET    /api/admin/users         List all users
DELETE /api/admin/users/:username   Delete user
GET    /api/admin/sessions      List active sessions
DELETE /api/admin/sessions/:token   Terminate session
```

### Jupyter Proxy
```
/*     /jupyter/*               Proxy all requests to Jupyter
                                (session token validated)
```

---

## ✅ Complete User Journey Example

```
DAY 1: New User "Alice" Signs Up
──────────────────────────────────
1. Opens http://localhost:3000
2. Clicks "Sign Up"
3. Enters: username="alice", password="test123"
4. Backend creates:
   - User in users.json with hashed password
   - Directory: /notebooks/alice/
   - JWT token with role="user"
5. Frontend stores token, creates session
6. Alice sees Jupyter interface
7. Creates notebook: "My First Analysis.ipynb"
8. Writes Python code, runs cells
9. Saves notebook to /notebooks/alice/

DAY 2: Alice Returns
──────────────────────────────────
1. Opens http://localhost:3000
2. Frontend checks localStorage → token found
3. Auto-creates new Jupyter session
4. Alice sees her previous notebooks
5. Opens "My First Analysis.ipynb"
6. Continues work where she left off

MEANWHILE: Admin Tasks
──────────────────────────────────
1. Admin logs in with admin/admin
2. Navigates to /admin dashboard
3. Sees list: admin, alice
4. Views active sessions: alice's session
5. Can terminate sessions or delete users if needed
```

---

## 🛠️ Technology Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React | User interface |
| **Routing** | React Router | SPA navigation |
| **State** | React useState/useEffect | Client state |
| **Auth Storage** | localStorage | JWT persistence |
| **HTTP Client** | Fetch API | API calls |
| **Backend** | Node.js + Express | API server |
| **Auth** | JWT + bcrypt | Authentication |
| **Proxy** | http-proxy-middleware | Jupyter proxy |
| **Sessions** | In-memory Map | Session management |
| **Database** | users.json (file) | User storage |
| **Notebooks** | JupyterLab | Notebook engine |
| **Reverse Proxy** | Nginx | Request routing |
| **Container** | Docker Compose | Orchestration |

---

## 🎉 Key Features Summary

✅ **Secure Authentication**: JWT-based with bcrypt password hashing
✅ **Role-Based Access**: Admin and user roles  
✅ **Session Management**: Secure Jupyter access without exposing tokens
✅ **User Isolation**: Each user has their own notebook directory
✅ **Admin Dashboard**: User and session management
✅ **Persistent Storage**: Notebooks and users saved to disk
✅ **Dockerized**: Easy deployment with docker-compose
✅ **Proxy Architecture**: Clean separation of concerns

---

**This is your complete MLHub workflow!**

From user registration to notebook execution to admin management, every aspect of the application is documented above.
