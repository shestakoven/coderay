import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { label: string; children: ReactNode }
interface State { error: Error | null }

const mounted = new Set<ErrorBoundary>();

// A half-applied hot update (several files saved one by one) can throw once; the next update usually fixes it.
if (import.meta.hot) import.meta.hot.on('vite:afterUpdate', () => mounted.forEach((boundary) => boundary.reset()));

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidMount(): void {
    mounted.add(this);
  }

  componentWillUnmount(): void {
    mounted.delete(this);
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label} crashed`, error, info.componentStack);
  }

  reset(): void {
    if (this.state.error) this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <b>{this.props.label} crashed</b>
        <code>{error.message}</code>
        <span className="muted">It retries after the next code update.</span>
        <button onClick={() => this.reset()}>Try again</button>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
