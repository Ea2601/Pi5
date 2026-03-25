import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: string; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: '' };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI Error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 40, textAlign: 'center', color: '#ef4444',
          background: 'rgba(239,68,68,0.05)', borderRadius: 12, margin: 20,
          border: '1px solid rgba(239,68,68,0.2)'
        }}>
          <h3 style={{ marginBottom: 8 }}>Bir hata olustu</h3>
          <p style={{ color: '#94a3b8', fontSize: 13 }}>{this.state.error}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: '' })}
            style={{
              marginTop: 16, padding: '8px 20px', borderRadius: 8,
              background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500
            }}
          >
            Tekrar Dene
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
