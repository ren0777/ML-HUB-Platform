import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useParams } from 'react-router-dom';
import Login from './Login';
import AdminDashboard from './admin/AdminDashboard';
import AdminNotebookReview from './admin/AdminNotebookReview';
import CodeCoachPanel from './CodeCoachPanel';
import { jwtDecode } from 'jwt-decode';

function UsernameRouteGuard({ username, children }) {
  const { routeUsername } = useParams();

  if (!username) {
    return <Navigate to="/" replace />;
  }

  if (routeUsername !== username) {
    return <Navigate to={`/${username}`} replace />;
  }

  return children;
}

function QuotaSetupCard({ token, onQuotaSaved }) {
  const [tier, setTier] = useState('starter');
  const [customMemoryMi, setCustomMemoryMi] = useState(1024);
  const [customStorageGi, setCustomStorageGi] = useState(5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const tierOptions = {
    starter: { memoryMi: 1024, storageGi: 5 },
    standard: { memoryMi: 2048, storageGi: 10 },
    pro: { memoryMi: 4096, storageGi: 20 },
  };

  const quotaSelection = tier === 'custom'
    ? { memoryMi: Number(customMemoryMi), storageGi: Number(customStorageGi) }
    : tierOptions[tier];

  const isMemoryValid = Number.isInteger(quotaSelection.memoryMi) && quotaSelection.memoryMi >= 512 && quotaSelection.memoryMi <= 4096 && quotaSelection.memoryMi % 256 === 0;
  const isStorageValid = Number.isInteger(quotaSelection.storageGi) && quotaSelection.storageGi >= 5 && quotaSelection.storageGi <= 20;
  const canSubmit = isMemoryValid && isStorageValid && !saving;

  async function saveQuota(event) {
    event.preventDefault();
    setError(null);

    if (!canSubmit) {
      setError('Please choose a valid memory/storage combination within limits.');
      return;
    }

    setSaving(true);

    try {
      const response = await fetch('/api/auth/quota', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          memoryMi: quotaSelection.memoryMi,
          storageGi: quotaSelection.storageGi,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || `Quota save failed: ${response.status}`);
      }

      onQuotaSaved(payload.token);
    } catch (err) {
      setError(err.message || 'Failed to save quota.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workspace-panel quota-setup-panel">
      <p className="workspace-label">Final step after signup</p>
      <h2 className="workspace-main-title">Set your workspace quota</h2>
      <p className="workspace-copy workspace-copy-wide">
        Choose memory and storage for your containers. Hard limits apply: up to 4Gi memory and 20Gi storage.
      </p>

      <form className="quota-form" onSubmit={saveQuota}>
        <label className="login-field">
          <span>Quota preset</span>
          <select value={tier} onChange={(event) => setTier(event.target.value)}>
            <option value="starter">Starter - 1Gi memory / 5Gi storage</option>
            <option value="standard">Standard - 2Gi memory / 10Gi storage</option>
            <option value="pro">Pro - 4Gi memory / 20Gi storage</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        {tier === 'custom' && (
          <div className="quota-custom-grid">
            <label className="login-field">
              <span>Memory (Mi)</span>
              <input
                type="number"
                min="512"
                max="4096"
                step="256"
                value={customMemoryMi}
                onChange={(event) => setCustomMemoryMi(Number(event.target.value))}
                required
              />
            </label>

            <label className="login-field">
              <span>Storage (Gi)</span>
              <input
                type="number"
                min="5"
                max="20"
                step="1"
                value={customStorageGi}
                onChange={(event) => setCustomStorageGi(Number(event.target.value))}
                required
              />
            </label>
          </div>
        )}

        <div className="quota-summary">
          <strong>Selected:</strong> {quotaSelection.memoryMi}Mi memory, {quotaSelection.storageGi}Gi storage
        </div>

        {error && <div className="login-error">{error}</div>}

        <button type="submit" className="app-primary-button" disabled={!canSubmit}>
          {saving ? 'Saving quota...' : 'Continue to workspace'}
        </button>
      </form>
    </section>
  );
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [sessionToken, setSessionToken] = useState(null);
  const [jupyterBase, setJupyterBase] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [username, setUsername] = useState(null);
  const [quotaSetupComplete, setQuotaSetupComplete] = useState(true);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (storedToken) {
      setToken(storedToken);
      try {
        const decodedToken = jwtDecode(storedToken);
        setUserRole(decodedToken.role);
        setUsername(decodedToken.username || null);
        const setupDone = decodedToken.role === 'admin' ? true : decodedToken.quotaSetupComplete !== false;
        setQuotaSetupComplete(setupDone);
        if (setupDone) {
          createSession(storedToken);
        }
      } catch (err) {
        console.error('Failed to decode token:', err);
        handleLogout();
      }
    }

    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (token) {
      try {
        const decodedToken = jwtDecode(token);
        setUserRole(decodedToken.role);
        setUsername(decodedToken.username || null);
        setQuotaSetupComplete(decodedToken.role === 'admin' ? true : decodedToken.quotaSetupComplete !== false);
      } catch (err) {
        console.error('Failed to decode token on update:', err);
        setUserRole(null);
        setUsername(null);
        setQuotaSetupComplete(true);
      }
    } else {
      setUserRole(null);
      setUsername(null);
      setQuotaSetupComplete(true);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    const eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data?.type) {
          return;
        }

        if (data.type === 'user_deleted' && data.payload?.username === username) {
          setError('Your account was removed by an administrator.');
          handleLogout();
          return;
        }

        if (
          data.type === 'session_stopped' &&
          data.payload?.user === username &&
          data.payload?.sessionToken === sessionToken
        ) {
          setSessionToken(null);
          setJupyterBase(null);
          setIframeLoaded(false);
          setError('Your active session was stopped. Start a new notebook session.');
        }
      } catch (err) {
        // Ignore malformed/non-JSON event frames.
      }
    };

    return () => {
      eventSource.close();
    };
  }, [token, username, sessionToken]);

  const handleLogin = (newToken) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    try {
      const decodedToken = jwtDecode(newToken);
      setUserRole(decodedToken.role);
      setUsername(decodedToken.username || null);
      const setupDone = decodedToken.role === 'admin' ? true : decodedToken.quotaSetupComplete !== false;
      setQuotaSetupComplete(setupDone);
      if (setupDone) {
        createSession(newToken);
      }
    } catch (err) {
      console.error('Failed to decode new token:', err);
      setUserRole(null);
      setUsername(null);
      setQuotaSetupComplete(true);
    }
  };

  const clearAuthState = () => {
    localStorage.removeItem('token');
    setToken(null);
    setSessionToken(null);
    setJupyterBase(null);
    setUserRole(null);
    setUsername(null);
    setQuotaSetupComplete(true);
    setIframeLoaded(false);
  };

  const handleLogout = async () => {
    const currentToken = token || localStorage.getItem('token');
    const currentSessionToken = sessionToken;

    try {
      if (currentToken && currentSessionToken) {
        await fetch('/api/session/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: currentToken, sessionToken: currentSessionToken }),
        });
      }
    } catch (err) {
      console.warn('Failed to stop session during logout:', err);
    } finally {
      clearAuthState();
    }
  };

  const createSession = async (currentToken = token) => {
    setLoading(true);
    setError(null);
    
    if (!currentToken) {
      setError('No authentication token found. Please log in.');
      setLoading(false);
      return;
    }

    if (userRole !== 'admin' && !quotaSetupComplete) {
      setError('Complete your quota setup before launching notebook sessions.');
      setLoading(false);
      return;
    }

    try {
      if (sessionToken) {
        try {
          await fetch('/api/session/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: currentToken, sessionToken }),
          });
        } catch (stopErr) {
          console.warn('Failed to stop previous session:', stopErr);
        }
      }

      const res = await fetch('/api/session/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: currentToken }),
      });
      
      if (!res.ok) {
        let errorMessage = `HTTP error! status: ${res.status}`;
        try {
          const errorData = await res.json();
          errorMessage = errorData.message || errorMessage;
          console.error('API Error Response:', errorData);
        } catch (e) {
          console.error('API Error Response (non-JSON):', e);
        }
        
        if (res.status === 401) {
          console.error('401 Unauthorized error detected. Logging out.');
          handleLogout();
          setError('Session expired. Please log in again.');
          return;
        }
        
        throw new Error(errorMessage);
      }
      
      const data = await res.json();
      setIframeLoaded(false);
      setSessionToken(data.sessionToken);
      setJupyterBase(data.jupyterBase || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionToken) {
      setIframeLoaded(false);
      return;
    }

    const timeout = setTimeout(() => {
      const isAdminRoute = /\/admin\/?$/.test(window.location.pathname.toLowerCase());
      if (!iframeLoaded && !isAdminRoute) {
        setError('Notebook is taking too long to load. Please restart the notebook session.');
      }
    }, 25000);

    return () => clearTimeout(timeout);
  }, [sessionToken, iframeLoaded]);

  if (!authReady) {
    return (
      <div className="admin-loading-state" style={{ margin: '2rem' }}>
        <div className="workspace-loading-orb" />
        <span>Restoring session...</span>
      </div>
    );
  }

  if (!token) {
    return (
      <Router>
        <Routes>
          <Route path="/" element={<Login onLogin={handleLogin} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    );
  }

  const notebookUrl = `${jupyterBase || `/jupyter/${sessionToken}`}/lab`;
  const userPath = username ? `/${username}` : '/';
  const userAdminPath = username ? `/${username}/admin` : '/';
  const userNotebookReviewPath = username ? `/${username}/admin/notebooks` : '/';
  const userQuotaPath = username ? `/${username}/setup-quota` : '/';
  const isAdminDashboardRoute = /\/admin(\/notebooks)?\/?$/.test(window.location.pathname.toLowerCase());

  return (
    <Router>
      <div className="app-shell">
        <div className="app-backdrop app-backdrop-one" />
        <div className="app-backdrop app-backdrop-two" />
        <nav className="app-topbar">
          <div>
            <p className="app-eyebrow">Notebook Workspace</p>
            <h1 className="app-brand">MLHub</h1>
          </div>
          <div className="app-topbar-actions">
            {userRole === 'admin' && (
              <>
                <Link to={userAdminPath} className="app-admin-link">Admin Dashboard</Link>
                <Link to={userNotebookReviewPath} className="app-admin-link">User Notebooks</Link>
              </>
            )}
            <button onClick={handleLogout} className="app-ghost-button">
              Logout
            </button>
          </div>
        </nav>

        <main className="workspace-shell">
          {error && !isAdminDashboardRoute && (
            <div className="app-alert" role="alert">
              <strong>Session Alert</strong>
              <span>{error}</span>
            </div>
          )}

          <Routes>
            <Route path="/" element={<Navigate to={quotaSetupComplete ? userPath : userQuotaPath} replace />} />
            <Route path="/admin" element={<Navigate to={userRole === 'admin' ? userAdminPath : userPath} replace />} />
            <Route
              path="/:routeUsername/setup-quota"
              element={
                userRole === 'admin' ? (
                  <Navigate to={userPath} replace />
                ) : (
                  <UsernameRouteGuard username={username}>
                    {quotaSetupComplete ? (
                      <Navigate to={userPath} replace />
                    ) : (
                      <QuotaSetupCard token={token} onQuotaSaved={handleLogin} />
                    )}
                  </UsernameRouteGuard>
                )
              }
            />
            <Route
              path="/:routeUsername/admin/notebooks"
              element={
                userRole === 'admin' ? (
                  <UsernameRouteGuard username={username}>
                    <AdminNotebookReview />
                  </UsernameRouteGuard>
                ) : (
                  <Navigate to={userPath} replace />
                )
              }
            />
            <Route
              path="/:routeUsername/admin"
              element={
                userRole === 'admin' ? (
                  <UsernameRouteGuard username={username}>
                    <AdminDashboard />
                  </UsernameRouteGuard>
                ) : (
                  <Navigate to={userPath} replace />
                )
              }
            />
            <Route
              path="/:routeUsername"
              element={
                <UsernameRouteGuard username={username}>
                  {quotaSetupComplete ? (
                    <div className="workspace-grid">
                      <aside className="workspace-sidebar">
                      <section className="workspace-panel workspace-panel-primary">
                        <p className="workspace-label">Signed in as</p>
                        <h2 className="workspace-username">{username || 'Notebook User'}</h2>
                        <p className="workspace-copy">
                          Your personal notebook container starts in isolation, with its own runtime and storage path.
                        </p>
                        <div className="workspace-badges">
                          <span className="workspace-badge">{userRole === 'admin' ? 'Admin access' : 'User workspace'}</span>
                          <span className="workspace-badge workspace-badge-muted">Docker isolated</span>
                        </div>
                      </section>

                      <section className="workspace-panel">
                        <div className="workspace-stat-row">
                          <div>
                            <p className="workspace-label">Notebook status</p>
                            <h3 className="workspace-stat-title">{sessionToken ? (iframeLoaded ? 'Ready' : 'Booting') : 'Offline'}</h3>
                          </div>
                          <span className={`workspace-status-dot ${iframeLoaded ? 'is-ready' : loading || sessionToken ? 'is-loading' : ''}`} />
                        </div>

                        <dl className="workspace-meta">
                          <div>
                            <dt>Session</dt>
                            <dd>{sessionToken ? `${sessionToken.slice(0, 8)}...` : 'Not started'}</dd>
                          </div>
                          <div>
                            <dt>Base path</dt>
                            <dd>{jupyterBase || 'Pending session'}</dd>
                          </div>
                        </dl>

                        <div className="workspace-actions">
                          <button
                            onClick={() => createSession()}
                            disabled={loading}
                            className="app-primary-button"
                          >
                            {loading ? 'Starting workspace...' : sessionToken ? 'Restart notebook' : 'Launch notebook'}
                          </button>
                        </div>
                      </section>

                      <section className="workspace-panel workspace-panel-muted">
                        <p className="workspace-label">What you get</p>
                        <ul className="workspace-feature-list">
                          <li>Dedicated container per session</li>
                          <li>Fresh Jupyter Lab boot with isolated runtime</li>
                          <li>Automatic proxy routing through the app gateway</li>
                        </ul>
                      </section>
                      </aside>

                      <section className="workspace-main">
                        <div className="workspace-header-card">
                        <div>
                          <p className="workspace-label">Live notebook</p>
                          <h2 className="workspace-main-title">{iframeLoaded ? 'Jupyter Lab is ready' : 'Preparing your coding canvas'}</h2>
                          <p className="workspace-copy workspace-copy-wide">
                            {sessionToken
                              ? 'Your notebook opens inside the workspace frame below. If startup takes too long, restart the session from the side panel.'
                              : 'Start a fresh notebook session to open an isolated Jupyter Lab environment.'}
                          </p>
                        </div>
                          <div className="workspace-url-chip">{sessionToken ? notebookUrl : 'Awaiting launch'}</div>
                        </div>

                        {!sessionToken ? (
                          <div className="workspace-empty-state">
                          <div className="workspace-empty-icon">+</div>
                          <h3>Open your first session</h3>
                          <p>Spin up a dedicated notebook container and start working immediately.</p>
                          <button onClick={() => createSession()} disabled={loading} className="app-primary-button">
                            {loading ? 'Starting workspace...' : 'Create notebook session'}
                            </button>
                          </div>
                        ) : (
                          <div className="workspace-frame-shell">
                          {!iframeLoaded && (
                            <div className="workspace-loading-banner">
                              <div className="workspace-loading-orb" />
                              <div>
                                <strong>Loading notebook runtime</strong>
                                <p>We are connecting your isolated Jupyter Lab session.</p>
                              </div>
                            </div>
                          )}
                            <div className="workspace-frame-wrap">
                            <iframe
                              key={sessionToken}
                              title="Jupyter Lab"
                              src={notebookUrl}
                              onLoad={() => {
                                setIframeLoaded(true);
                                setError(null);
                              }}
                              className="workspace-frame"
                              allowFullScreen
                            />
                            </div>
                          </div>
                        )}

                        <CodeCoachPanel />
                      </section>
                    </div>
                  ) : (
                    <Navigate to={userQuotaPath} replace />
                  )}
                </UsernameRouteGuard>
              }
            />
            <Route path="*" element={<Navigate to={userPath} replace />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
