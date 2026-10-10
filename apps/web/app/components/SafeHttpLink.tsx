import { safeHttpUrl } from '@/lib/safe-http-url'

interface SafeHttpLinkProps {
  url: string
  className?: string
  /** Classes for the plain-text fallback shown when `url` is not http(s). */
  fallbackClassName?: string
}

/** Renders `url` as an external link only when it is http(s); otherwise as inert text. */
export function SafeHttpLink({ url, className, fallbackClassName }: SafeHttpLinkProps) {
  const href = safeHttpUrl(url)
  if (!href) {
    return (
      <span className={fallbackClassName} title={url}>
        {url}
      </span>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} title={url}>
      {url}
    </a>
  )
}
