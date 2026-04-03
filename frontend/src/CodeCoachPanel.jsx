import React, { useState } from 'react';

const DEFAULT_TESTS = `# Optional pytest tests (recommended)
# def test_example():
#     assert add(1, 2) == 3
`;

function CodeCoachPanel() {
  const [code, setCode] = useState('');
  const [tests, setTests] = useState(DEFAULT_TESTS);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function analyzeCode() {
    if (!code.trim()) {
      setError('Please paste Python code before analysis.');
      return;
    }

    setStatus('running-tests');
    setError(null);
    setResult(null);

    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/code-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          language: 'python',
          code,
          tests,
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload?.message || `Analysis failed: ${res.status}`);
      }

      setStatus('done');
      setResult(payload);
    } catch (err) {
      setStatus('failed');
      setError(err.message || 'Analysis failed.');
    }
  }

  const verdictClass = result?.verdict === 'correct' ? 'is-correct' : result?.verdict === 'wrong' ? 'is-wrong' : '';

  return (
    <section className="workspace-panel code-coach-panel">
      <div className="code-coach-header">
        <div className="code-coach-header-content">
          <div>
            <p className="workspace-label">Senpai 🧑‍🏫</p>
            <h2 className="code-coach-title">Analyze Your Code</h2>
          </div>
          {result?.verdict && (
            <span className={`code-coach-verdict ${verdictClass}`}>
              {result.verdict === 'correct' ? '✓ Correct' : result.verdict === 'wrong' ? '✗ Wrong' : '○ Unknown'}
            </span>
          )}
        </div>
        <p className="code-coach-subtitle">
          Test first, then get expert feedback from Gemini AI
        </p>
      </div>

      <div className="code-coach-grid">
        <label className="login-field">
          <span>Python code</span>
          <textarea
            className="code-coach-textarea"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="def add(a, b):\n    return a + b"
          />
        </label>

        <label className="login-field">
          <span>Pytest tests (optional)</span>
          <textarea
            className="code-coach-textarea"
            value={tests}
            onChange={(event) => setTests(event.target.value)}
          />
        </label>
      </div>

      <div className="workspace-actions">
        <button type="button" className="code-coach-button" onClick={analyzeCode} disabled={status === 'running-tests'}>
          {status === 'running-tests' ? 'Running tests...' : 'Analyze code'}
        </button>
      </div>

      {error && (
        <div className="app-alert" role="alert">
          <strong>Analysis Error</strong>
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="code-coach-results">
          <article className="code-coach-card">
            <h4>Hint</h4>
            <p>{result.hint || 'No hint available.'}</p>
          </article>

          <article className="code-coach-card">
            <h4>Explanation</h4>
            <p>{result.explanation || 'No explanation returned yet.'}</p>
          </article>

          <article className="code-coach-card">
            <h4>Suggestions</h4>
            {Array.isArray(result.suggestions) && result.suggestions.length > 0 ? (
              <ul className="workspace-feature-list">
                {result.suggestions.map((suggestion, index) => (
                  <li key={`${suggestion}-${index}`}>{suggestion}</li>
                ))}
              </ul>
            ) : (
              <p>No extra suggestions available.</p>
            )}
          </article>

          <article className="code-coach-card code-coach-output-card">
            <h4>Test output</h4>
            <pre>{result?.testRun?.stdout || result?.testRun?.stderr || 'No output captured.'}</pre>
          </article>
        </div>
      )}
    </section>
  );
}

export default CodeCoachPanel;
