import React, { useState, useEffect } from 'react';

const REFRESH_INTERVAL_MS = 15000;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const formatted = value / 1024 ** exponent;
  return `${formatted.toFixed(formatted >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatModeLabel(mode) {
  if (mode === 'k8s') {
    return 'Kubernetes';
  }

  if (mode === 'docker') {
    return 'Docker';
  }

  return mode || 'Unknown';
}

function UsageMeter({ label, used, free, percent, tone = 'accent' }) {
  return (
    <div className="admin-analytics-card">
      <div className="admin-analytics-head">
        <span>{label}</span>
        <strong>{percent.toFixed(1)}%</strong>
      </div>
      <div className="admin-analytics-bar" aria-hidden="true">
        <span className={`admin-analytics-bar-fill is-${tone}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      <div className="admin-analytics-values">
        <div>
          <span>Used</span>
          <strong>{formatBytes(used)}</strong>
        </div>
        <div>
          <span>Free</span>
          <strong>{formatBytes(free)}</strong>
        </div>
      </div>
    </div>
  );
}

function AdminDashboard() {
  const [users, setUsers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [userUsage, setUserUsage] = useState([]);
  const [selectedUsageUser, setSelectedUsageUser] = useState('');
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [addingUser, setAddingUser] = useState(false);
  const [stoppingSessionId, setStoppingSessionId] = useState(null);

  useEffect(() => {
    fetchAdminData();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      fetchAdminData({ silent: true });
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
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

        if (
          data.type === 'user_added' ||
          data.type === 'user_deleted' ||
          data.type === 'session_started' ||
          data.type === 'session_stopped'
        ) {
          fetchAdminData();
        }
      } catch (err) {
        // Ignore malformed/non-JSON event frames.
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setError('Admin token not found. Please log in as admin.');
      return null;
    }
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  };

  const fetchAdminData = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }
    setError(null);
    const headers = getAuthHeaders();
    if (!headers) {
      if (!silent) {
        setLoading(false);
      }
      return;
    }

    try {
      const authHeaders = { 'Authorization': headers.Authorization };
      const [usersRes, sessionsRes, analyticsRes, userUsageRes] = await Promise.all([
        fetch('/api/admin/users', { headers: authHeaders }),
        fetch('/api/admin/sessions', { headers: authHeaders }),
        fetch('/api/admin/analytics', { headers: authHeaders }),
        fetch('/api/admin/user-usage', { headers: authHeaders }),
      ]);

      if (!usersRes.ok) {
        throw new Error(`Failed to fetch users: ${usersRes.statusText}`);
      }

      if (!sessionsRes.ok) {
        throw new Error(`Failed to fetch sessions: ${sessionsRes.statusText}`);
      }

      if (!analyticsRes.ok) {
        throw new Error(`Failed to fetch analytics: ${analyticsRes.statusText}`);
      }

      if (!userUsageRes.ok) {
        throw new Error(`Failed to fetch per-user usage: ${userUsageRes.statusText}`);
      }

      const [usersData, sessionsData, analyticsData, userUsageData] = await Promise.all([
        usersRes.json(),
        sessionsRes.json(),
        analyticsRes.json(),
        userUsageRes.json(),
      ]);

      setUsers(usersData);
      setSessions(sessionsData);
      setAnalytics(analyticsData);
      const usageItems = Array.isArray(userUsageData?.items) ? userUsageData.items : [];
      setUserUsage(usageItems);
      setSelectedUsageUser((previous) => {
        if (previous && usageItems.some((item) => item.username === previous)) {
          return previous;
        }

        if (usageItems.length > 0) {
          return usageItems[0].username;
        }

        return '';
      });

    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const handleDeleteUser = async (username) => {
    if (!window.confirm(`Are you sure you want to delete user ${username}?`)) {
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
      setError('Admin token not found.');
      return;
    }

    try {
      const res = await fetch(`/api/admin/user/${username}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || `Failed to delete user: ${res.statusText}`);
      }
      fetchAdminData(); // Refresh data after deletion
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setAddingUser(true);
    setError(null);

    const headers = getAuthHeaders();
    if (!headers) {
      setAddingUser(false);
      return;
    }

    try {
      const res = await fetch('/api/admin/user', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(newUser)
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || `Failed to add user: ${res.statusText}`);
      }
      setNewUser({ username: '', password: '', role: 'user' }); // Clear form
      fetchAdminData(); // Refresh data
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingUser(false);
    }
  };

  const handleStopSession = async (sessionId, sessionUser) => {
    if (!window.confirm(`Stop active session ${sessionId.slice(0, 8)}... for ${sessionUser}?`)) {
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
      setError('Admin token not found.');
      return;
    }

    setStoppingSessionId(sessionId);
    setError(null);

    try {
      const res = await fetch('/api/session/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, sessionToken: sessionId }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to stop session: ${res.statusText}`);
      }

      fetchAdminData();
    } catch (err) {
      setError(err.message);
    } finally {
      setStoppingSessionId(null);
    }
  };

  if (loading) {
    return (
      <div className="admin-loading-state">
        <div className="workspace-loading-orb" />
        <span>Loading admin dashboard...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-alert" role="alert">
        <strong>Admin Error</strong>
        <span>{error}</span>
      </div>
    );
  }

  const hostMemory = analytics?.hostMemory;
  const storage = analytics?.storage;
  const selectedUsage = userUsage.find((item) => item.username === selectedUsageUser) || null;
  const selectedUsageMemory = selectedUsage?.memory || null;
  const selectedUsageStorage = selectedUsage?.storage || null;
  const selectedStorageUsedBytes = Number.isFinite(selectedUsageStorage?.usedBytes) ? selectedUsageStorage.usedBytes : null;
  const selectedStorageRequestedBytes = Number.isFinite(selectedUsageStorage?.requestedBytes) ? selectedUsageStorage.requestedBytes : 0;
  const selectedStoragePercent = selectedStorageRequestedBytes > 0 && selectedStorageUsedBytes !== null
    ? (selectedStorageUsedBytes / selectedStorageRequestedBytes) * 100
    : 0;
  const processHeapPercent = analytics?.processMemory?.heapTotalBytes
    ? (analytics.processMemory.heapUsedBytes / analytics.processMemory.heapTotalBytes) * 100
    : 0;
  const lastUpdated = analytics?.generatedAt
    ? new Date(analytics.generatedAt).toLocaleTimeString()
    : null;

  return (
    <div className="admin-shell">
      <section className="workspace-header-card admin-header-card">
        <div>
          <p className="workspace-label">Admin control room</p>
          <h1 className="workspace-main-title">Manage users and live notebook sessions</h1>
          <p className="workspace-copy workspace-copy-wide">
            Create accounts, monitor active sessions, and keep the multi-container workspace under control from one place.
          </p>
        </div>
        <div className="admin-metrics">
          <div className="admin-metric-card">
            <span>Total users</span>
            <strong>{users.length}</strong>
          </div>
          <div className="admin-metric-card">
            <span>Active sessions</span>
            <strong>{sessions.length}</strong>
          </div>
          <div className="admin-metric-card">
            <span>RAM in use</span>
            <strong>{hostMemory ? `${hostMemory.usagePercent.toFixed(1)}%` : '--'}</strong>
          </div>
        </div>
      </section>

      <section className="workspace-panel admin-analytics-panel">
        <div className="admin-section-head admin-section-head-compact">
          <div>
            <p className="workspace-label">Analytics</p>
            <h2 className="admin-section-title">Live resource usage</h2>
          </div>
          <div className="admin-analytics-stamp">
            <span>Refreshes every 15s</span>
            <strong>{lastUpdated ? `Updated ${lastUpdated}` : 'Waiting for metrics'}</strong>
          </div>
        </div>

        <div className="admin-analytics-grid">
          <UsageMeter
            label="Host RAM"
            used={hostMemory?.usedBytes || 0}
            free={hostMemory?.freeBytes || 0}
            percent={hostMemory?.usagePercent || 0}
            tone="accent"
          />

          <UsageMeter
            label="Backend heap"
            used={analytics?.processMemory?.heapUsedBytes || 0}
            free={Math.max(0, (analytics?.processMemory?.heapTotalBytes || 0) - (analytics?.processMemory?.heapUsedBytes || 0))}
            percent={processHeapPercent}
            tone="deep"
          />

          <UsageMeter
            label="Server storage"
            used={storage?.usedBytes || 0}
            free={storage?.freeBytes || 0}
            percent={storage?.usagePercent || 0}
            tone="success"
          />
        </div>

        <div className="admin-analytics-footnotes">
          <div className="admin-analytics-note">
            <span>Notebook RAM cap reserved</span>
            <strong>{formatBytes(analytics?.sessionCapacity?.reservedBytes || 0)}</strong>
          </div>
          <div className="admin-analytics-note">
            <span>Per-session memory limit</span>
            <strong>{formatBytes(analytics?.sessionCapacity?.configuredPerSessionLimitBytes || 0)}</strong>
          </div>
          <div className="admin-analytics-note">
            <span>Tracked filesystem</span>
            <strong>{storage?.path || 'Unavailable'}</strong>
          </div>
        </div>
      </section>

      <section className="workspace-panel admin-user-usage-panel">
        <div className="admin-section-head admin-section-head-compact">
          <div>
            <p className="workspace-label">Per-user telemetry</p>
            <h2 className="admin-section-title">User storage and memory</h2>
          </div>
          <div className="admin-user-usage-picker-wrap">
            <label htmlFor="usage-user-select" className="admin-user-usage-picker-label">Select user</label>
            <select
              id="usage-user-select"
              className="admin-user-usage-picker"
              value={selectedUsageUser}
              onChange={(event) => setSelectedUsageUser(event.target.value)}
            >
              {userUsage.map((item) => (
                <option key={item.username} value={item.username}>{item.username}</option>
              ))}
            </select>
          </div>
        </div>

        {selectedUsage ? (
          <div className="admin-user-usage-grid">
            <div className="admin-user-usage-card">
              <div className="admin-user-usage-top">
                <span className={`admin-user-state-pill ${selectedUsage.active ? 'is-active' : 'is-offline'}`}>
                  {selectedUsage.active ? 'Active session' : 'Offline'}
                </span>
                <span className="admin-user-mode-pill">{formatModeLabel(selectedUsage.mode)}</span>
              </div>
              <h3>{selectedUsage.username}</h3>
              <p>
                {selectedUsage.active
                  ? `Session ${String(selectedUsage.sessionToken || '').slice(0, 8)}... is consuming live resources.`
                  : 'No running container right now. Persistent storage remains available for next login.'}
              </p>
            </div>

            <UsageMeter
              label="User memory"
              used={selectedUsageMemory?.usedBytes || 0}
              free={selectedUsageMemory?.freeBytes || 0}
              percent={selectedUsageMemory?.usagePercent || 0}
              tone="deep"
            />

            <UsageMeter
              label="User storage"
              used={selectedStorageUsedBytes || 0}
              free={Math.max(0, selectedStorageRequestedBytes - (selectedStorageUsedBytes || 0))}
              percent={selectedStoragePercent}
              tone="success"
            />
          </div>
        ) : (
          <div className="admin-empty-cell">No user usage data available.</div>
        )}

        {selectedUsageStorage?.message && (
          <p className="admin-user-usage-note">{selectedUsageStorage.message}</p>
        )}

        <div className="admin-user-usage-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Memory Used</th>
                <th>Storage Used</th>
              </tr>
            </thead>
            <tbody>
              {userUsage.length > 0 ? (
                userUsage.map((item) => (
                  <tr key={item.username}>
                    <td>{item.username}</td>
                    <td>{item.active ? 'Active' : 'Offline'}</td>
                    <td>{formatBytes(item.memory?.usedBytes || 0)}</td>
                    <td>{Number.isFinite(item.storage?.usedBytes) ? formatBytes(item.storage.usedBytes) : 'Unavailable'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="4" className="admin-empty-cell">No user usage rows yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="admin-grid">
        <section className="workspace-panel admin-form-panel">
          <p className="workspace-label">Provision access</p>
          <h2 className="admin-section-title">Add new user</h2>
          <form onSubmit={handleAddUser} className="admin-form">
            <label className="login-field">
              <span>Username</span>
              <input
                type="text"
                id="new-username"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                required
              />
            </label>

            <label className="login-field">
              <span>Password</span>
              <input
                type="password"
                id="new-password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                required
              />
            </label>

            <label className="login-field">
              <span>Role</span>
              <select
                id="new-role"
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </label>

            <button type="submit" disabled={addingUser} className="app-primary-button">
              {addingUser ? 'Adding user...' : 'Add user'}
            </button>
          </form>
        </section>

        <section className="admin-stack">
          <section className="workspace-panel admin-table-panel">
            <div className="admin-section-head">
              <div>
                <p className="workspace-label">Directory</p>
                <h2 className="admin-section-title">Users</h2>
              </div>
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length > 0 ? (
                    users.map((user) => (
                      <tr key={user.username}>
                        <td>{user.username}</td>
                        <td>
                          <span className={`admin-role-pill ${user.role === 'admin' ? 'is-admin' : ''}`}>{user.role}</span>
                        </td>
                        <td>
                          <button
                            onClick={() => handleDeleteUser(user.username)}
                            className="admin-delete-button"
                            disabled={user.username === 'admin'}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="3" className="admin-empty-cell">No users found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="workspace-panel admin-table-panel">
            <div className="admin-section-head">
              <div>
                <p className="workspace-label">Runtime overview</p>
                <h2 className="admin-section-title">Active sessions</h2>
              </div>
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Session ID</th>
                    <th>User</th>
                    <th>Created At</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.length > 0 ? (
                    sessions.map(([sessionId, sessionData]) => (
                      <tr key={sessionId}>
                        <td>{sessionId}</td>
                        <td>{sessionData.user}</td>
                        <td>{new Date(sessionData.created).toLocaleString()}</td>
                        <td>
                          <button
                            onClick={() => handleStopSession(sessionId, sessionData.user)}
                            className="admin-stop-button"
                            disabled={stoppingSessionId === sessionId}
                          >
                            {stoppingSessionId === sessionId ? 'Stopping...' : 'Stop'}
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="4" className="admin-empty-cell">No active sessions found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      </div>
    </div>
  );
}

export default AdminDashboard;
