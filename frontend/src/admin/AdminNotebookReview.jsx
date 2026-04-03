import React, { useEffect, useMemo, useState } from 'react';

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const display = value / 1024 ** index;
  return `${display.toFixed(display >= 10 ? 0 : 1)} ${units[index]}`;
}

function getNotebookCellPreview(cell) {
  const source = Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source || '');
  return source.trim() || '[empty cell]';
}

function AdminNotebookReview() {
  const [items, setItems] = useState([]);
  const [selectedUser, setSelectedUser] = useState('all');
  const [selectedNotebook, setSelectedNotebook] = useState(null);
  const [notebookDetail, setNotebookDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState(null);

  const users = useMemo(() => {
    const allUsers = new Set(items.map((item) => item.username));
    return Array.from(allUsers).sort((left, right) => left.localeCompare(right));
  }, [items]);

  const filteredItems = useMemo(() => {
    if (selectedUser === 'all') {
      return items;
    }

    return items.filter((item) => item.username === selectedUser);
  }, [items, selectedUser]);

  useEffect(() => {
    fetchNotebookIndex();
  }, []);

  async function fetchNotebookIndex({ preserveSelection = false } = {}) {
    setLoading(true);
    setError(null);

    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/admin/notebooks', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to load notebooks: ${res.status}`);
      }

      const payload = await res.json();
      const notebookItems = Array.isArray(payload?.items) ? payload.items : [];
      setItems(notebookItems);

      if (notebookItems.length > 0) {
        let nextSelected = notebookItems[0];

        if (preserveSelection && selectedNotebook?.id) {
          const matched = notebookItems.find((item) => item.id === selectedNotebook.id);
          if (matched) {
            nextSelected = matched;
          }
        }

        setSelectedNotebook(nextSelected);
        fetchNotebookDetail(nextSelected);
      } else {
        setSelectedNotebook(null);
        setNotebookDetail(null);
      }
    } catch (err) {
      setError(err.message || 'Failed to load notebooks.');
    } finally {
      setLoading(false);
    }
  }

  async function fetchNotebookDetail(item) {
    if (!item) {
      return;
    }

    setLoadingDetail(true);
    setError(null);

    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({
        username: item.username,
        notebookPath: item.notebookPath,
        source: item.source || 'local',
      });

      const res = await fetch(`/api/admin/notebook-content?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to load notebook content: ${res.status}`);
      }

      const payload = await res.json();
      setNotebookDetail(payload);
    } catch (err) {
      setNotebookDetail(null);
      setError(err.message || 'Failed to load notebook detail.');
    } finally {
      setLoadingDetail(false);
    }
  }

  const notebookCells = Array.isArray(notebookDetail?.notebook?.cells)
    ? notebookDetail.notebook.cells
    : Array.isArray(notebookDetail?.notebook?.content?.cells)
      ? notebookDetail.notebook.content.cells
      : Array.isArray(notebookDetail?.notebook?.content)
        ? notebookDetail.notebook.content
        : [];

  if (loading) {
    return (
      <div className="admin-loading-state">
        <div className="workspace-loading-orb" />
        <span>Loading notebook review page...</span>
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <section className="workspace-header-card admin-header-card">
        <div>
          <p className="workspace-label">Invigilator mode</p>
          <h1 className="workspace-main-title">Review all users notebooks</h1>
          <p className="workspace-copy workspace-copy-wide">
            This page is separate from dashboard metrics, so admins can focus on notebook/code inspection only.
          </p>
        </div>
        <div className="admin-metrics">
          <div className="admin-metric-card">
            <span>Users</span>
            <strong>{users.length}</strong>
          </div>
          <div className="admin-metric-card">
            <span>Notebooks</span>
            <strong>{items.length}</strong>
          </div>
        </div>
      </section>

      {error && (
        <div className="app-alert" role="alert">
          <strong>Notebook Review Error</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="workspace-panel admin-notebook-toolbar">
        <div className="admin-notebook-toolbar-actions">
          <label className="admin-user-usage-picker-wrap">
            <span className="admin-user-usage-picker-label">Filter by user</span>
            <select
              className="admin-user-usage-picker"
              value={selectedUser}
              onChange={(event) => setSelectedUser(event.target.value)}
            >
              <option value="all">All users</option>
              {users.map((username) => (
                <option key={username} value={username}>{username}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="app-admin-link admin-refresh-button"
            onClick={() => fetchNotebookIndex({ preserveSelection: true })}
            disabled={loading || loadingDetail}
          >
            {loading ? 'Refreshing...' : 'Refresh notebooks'}
          </button>
        </div>
      </section>

      <div className="admin-review-grid">
        <section className="workspace-panel admin-table-panel">
          <div className="admin-section-head">
            <div>
              <p className="workspace-label">Notebook index</p>
              <h2 className="admin-section-title">Users notebook files</h2>
            </div>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Notebook</th>
                  <th>Source</th>
                  <th>Size</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length > 0 ? (
                  filteredItems.map((item) => (
                    <tr
                      key={item.id}
                      className={selectedNotebook?.id === item.id ? 'admin-row-selected' : ''}
                      onClick={() => {
                        setSelectedNotebook(item);
                        fetchNotebookDetail(item);
                      }}
                    >
                      <td>{item.username}</td>
                      <td>{item.notebookPath}</td>
                      <td>{item.source}</td>
                      <td>{formatBytes(item.sizeBytes)}</td>
                      <td>{new Date(item.updatedAt).toLocaleString()}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="5" className="admin-empty-cell">No notebooks found for this filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="workspace-panel admin-notebook-preview-panel">
          <div className="admin-section-head">
            <div>
              <p className="workspace-label">Notebook preview</p>
              <h2 className="admin-section-title">
                {selectedNotebook ? `${selectedNotebook.username} / ${selectedNotebook.name}` : 'Select a notebook'}
              </h2>
            </div>
          </div>

          {loadingDetail && (
            <div className="admin-loading-state">
              <div className="workspace-loading-orb" />
              <span>Loading notebook content...</span>
            </div>
          )}

          {!loadingDetail && notebookCells.length === 0 && (
            <div className="admin-empty-cell">Notebook has no cells or content is unavailable.</div>
          )}

          {!loadingDetail && notebookCells.length > 0 && (
            <div className="admin-notebook-cells">
              {notebookCells.map((cell, index) => {
                const preview = getNotebookCellPreview(cell);
                return (
                  <article key={`${cell?.id || index}-${index}`} className="admin-notebook-cell">
                    <header>
                      <span>Cell {index + 1}</span>
                      <strong>{cell?.cell_type || 'unknown'}</strong>
                    </header>
                    <pre>{preview}</pre>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default AdminNotebookReview;
