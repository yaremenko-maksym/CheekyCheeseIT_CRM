import { Toaster as Sonner, type ToasterProps } from 'sonner'

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      position="top-center"
      closeButton
      style={
        {
          '--normal-bg': 'var(--card)',
          '--normal-border': 'var(--border)',
          '--normal-text': 'var(--foreground)',
          '--success-bg': 'var(--card)',
          '--success-border': 'var(--border)',
          '--success-text': 'var(--foreground)',
          '--error-bg': 'var(--card)',
          '--error-border': 'var(--border)',
          '--error-text': 'var(--foreground)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
