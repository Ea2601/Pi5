import { CheckCircle, AlertTriangle } from 'lucide-react';

interface AlertProps {
  type: 'success' | 'error';
  message: string;
}

export function Alert({ type, message }: AlertProps) {
  return (
    <div className={`alert alert-${type}`}>
      {type === 'success' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
      <span>{message}</span>
    </div>
  );
}
