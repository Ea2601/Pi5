interface BadgeProps {
  variant: 'success' | 'error' | 'info' | 'neutral' | 'warning';
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant, children, className = '' }: BadgeProps) {
  return <span className={`badge badge-${variant} ${className}`}>{children}</span>;
}
