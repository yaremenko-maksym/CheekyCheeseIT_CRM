/** Production CSP shared by bootstrap and focused policy tests. */
export const PRODUCTION_CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  // Document previews use presigned HTTPS URLs and are intentionally image-only.
  imgSrc: ["'self'", 'data:', 'https:', 'https://api.dicebear.com'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameSrc: ["'self'", 'blob:'],
  objectSrc: ["'self'", 'blob:'],
  // Meeting Recorder playback uses presigned private R2 URLs directly from
  // native <video>/<audio> elements. Keep this narrower than img-src: the
  // application never needs arbitrary third-party media origins.
  mediaSrc: ["'self'", 'https://*.r2.cloudflarestorage.com'],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
} as const
