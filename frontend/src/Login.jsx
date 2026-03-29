import React, { useState } from 'react';

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const endpoint = isSigningUp ? '/api/auth/signup' : '/api/auth/login';
    
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || `HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      onLogin(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-backdrop login-backdrop-one" />
      <div className="login-backdrop login-backdrop-two" />

      <section className="login-hero">
        <p className="login-eyebrow">Container-native notebooks</p>
        <h1 className="login-title">A sharper workspace for focused users.</h1>
        <p className="login-copy">
          Launch isolated Jupyter sessions with a cleaner interface, faster restart flow, and a dedicated container behind every notebook.
        </p>

        <div className="login-feature-grid">
          <div className="login-feature-card">
            <span>01</span>
            <h3>Private runtime</h3>
            <p>Each notebook session starts in its own container with independent compute and paths.</p>
          </div>
          <div className="login-feature-card">
            <span>02</span>
            <h3>Fast launch</h3>
            <p>Session startup is monitored before the workspace opens, reducing broken loads.</p>
          </div>
        </div>
      </section>

      <section className="login-card">
        <p className="login-card-label">{isSigningUp ? 'Create account' : 'Welcome back'}</p>
        <h2 className="login-card-title">{isSigningUp ? 'Start your notebook workspace' : 'Sign in to your lab'}</h2>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="login-field">
            <span>Username</span>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              required
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
            />
          </label>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" disabled={loading} className="app-primary-button login-submit">
            {loading ? 'Working...' : (isSigningUp ? 'Create account' : 'Enter workspace')}
          </button>
        </form>

        <button onClick={() => setIsSigningUp(!isSigningUp)} className="login-switch">
          {isSigningUp ? 'Already have an account? Login' : 'Need an account? Sign Up'}
        </button>
      </section>
    </div>
  );
}

export default Login;
