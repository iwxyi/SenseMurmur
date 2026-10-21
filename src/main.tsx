import './services/workspaceLifecycleBootstrap';
import { createRoot } from 'react-dom/client';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import App from './App';
import './services/diagnosticsBootstrap';


const style = document.createElement('style');
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #root { height: 100%; width: 100%; }
`;
document.head.appendChild(style);

class StartupErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[pneumata] application render failed', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: '100%', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#333' }}>
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>页面加载失败</h1>
          <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#666' }}>
            {this.state.error.message || '应用初始化时发生未知错误'}
          </p>
          <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 16, padding: '8px 14px' }}>
            重新加载
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StartupErrorBoundary>
    <App />
  </StartupErrorBoundary>,
);

root.render(
  <StartupErrorBoundary>
    <App />
  </StartupErrorBoundary>,
);
