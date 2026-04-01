import React, { useState, useEffect } from 'react';

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('form'); // 'form', 'otp-verify', 'otp-wait'
  const [otpTimer, setOtpTimer] = useState(0);
  const [otpAttempts, setOtpAttempts] = useState(0);

  // OTP timer countdown
  useEffect(() => {
    if (otpTimer > 0) {
      const interval = setTimeout(() => setOtpTimer(otpTimer - 1), 1000);
      return () => clearTimeout(interval);
    }
  }, [otpTimer]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (isSigningUp) {
      await handleSignupFlow();
    } else {
      await handleLogin();
    }
  };

  const handleLogin = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
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

  const handleSignupFlow = async () => {
    if (step === 'form') {
      // Request OTP
      setLoading(true);
      setError(null);

      try {
        const res = await fetch('/api/auth/signup/request-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.message || `HTTP error! status: ${res.status}`);
        }

        setStep('otp-verify');
        setOtpTimer(300); // 5 minutes
        setOtpAttempts(0);
        setOtp('');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    } else if (step === 'otp-verify') {
      // Verify OTP
      setLoading(true);
      setError(null);

      try {
        const res = await fetch('/api/auth/signup/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, otp }),
        });

        if (!res.ok) {
          const data = await res.json();
          setOtpAttempts(otpAttempts + 1);
          throw new Error(data.message || `HTTP error! status: ${res.status}`);
        }

        const data = await res.json();
        onLogin(data.token);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleResendOtp = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/signup/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || `HTTP error! status: ${res.status}`);
      }

      setOtpTimer(300); // Reset 5 minutes
      setOtpAttempts(0);
      setOtp('');
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setUsername('');
    setEmail('');
    setPassword('');
    setOtp('');
    setStep('form');
    setOtpTimer(0);
    setOtpAttempts(0);
    setError(null);
    setLoading(false);
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
        {step === 'form' ? (
          <>
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

              {isSigningUp && (
                <label className="login-field">
                  <span>College Email</span>
                  <input
                    type="email"
                    id="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your.name@gla.ac.in"
                    required
                  />
                </label>
              )}

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

            <button onClick={() => { setIsSigningUp(!isSigningUp); setError(null); }} className="login-switch">
              {isSigningUp ? 'Already have an account? Login' : 'Need an account? Sign Up'}
            </button>
          </>
        ) : (
          <>
            <p className="login-card-label">Verify your email</p>
           <h2 className="login-card-title"> Enter the OTP sent to <span className="login-email">{email}</span> </h2>

            <form onSubmit={handleSubmit} className="login-form">
              <label className="login-field">
                <span>OTP Code</span>
                <input
                  type="text"
                  id="otp"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  maxLength="6"
                  required
                />
              </label>

              {error && <div className="login-error">{error}</div>}

              <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: '1rem' }}>
                OTP expires in {Math.floor(otpTimer / 60)}:{(otpTimer % 60).toString().padStart(2, '0')}
              </div>

              <button type="submit" disabled={loading || otp.length !== 6} className="app-primary-button login-submit">
                {loading ? 'Verifying...' : 'Verify OTP'}
              </button>
            </form>

            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
              <button onClick={handleResendOtp} disabled={loading || otpTimer > 240} className="login-switch">
                Resend OTP
              </button>
              <button onClick={handleReset} className="login-switch">
                Back
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default Login;
