export interface IosProbe {
  userAgent: string
  platform: string
  maxTouchPoints: number
}

/**
 * iOS/iPadOS detection. iPadOS 13+ reports a desktop UA ("MacIntel"), so it is
 * recognised by platform + multi-touch. WebKit on iOS (all iOS browsers) does not
 * paint blob-PDF iframes.
 */
export function isIosDevice({ userAgent, platform, maxTouchPoints }: IosProbe): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true
  return platform === 'MacIntel' && maxTouchPoints > 1
}

export function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIosDevice({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  })
}
