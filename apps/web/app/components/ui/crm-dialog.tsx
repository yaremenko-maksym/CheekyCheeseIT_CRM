import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from './dialog'

// CrmDialogContent — always max-h-[90dvh], flex-col, scrollable body.
// A11y contract: the CALLER must place <DialogTitle> and <DialogDescription>
// (visible or sr-only) inside children. CrmDialogContent does NOT inject them.
// The `title` HTML attribute is NOT a substitute — it produces no accessible name.
//
// Correct usage:
//   <CrmDialogContent>
//     <CrmDialogHeader>
//       <DialogTitle>Заголовок</DialogTitle>
//       <DialogDescription className="sr-only">Краткое описание</DialogDescription>
//     </CrmDialogHeader>
//     <CrmDialogBody>...form fields...</CrmDialogBody>
//     <CrmDialogFooter>...buttons...</CrmDialogFooter>
//   </CrmDialogContent>

const CrmDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    maxWidth?: string
  }
>(({ className, children, maxWidth = 'sm:max-w-md', ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 flex flex-col w-full translate-x-[-50%] translate-y-[-50%]',
        'max-h-[90dvh] border border-border bg-card shadow-xl duration-200',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
        'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        'sm:rounded-xl',
        maxWidth,
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
CrmDialogContent.displayName = 'CrmDialogContent'

// Fixed header — never scrolls away
const CrmDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('shrink-0 px-6 pt-6 pb-4', className)} {...props} />
)
CrmDialogHeader.displayName = 'CrmDialogHeader'

// Scrollable body
const CrmDialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex-1 overflow-y-auto px-6', className)} {...props} />
)
CrmDialogBody.displayName = 'CrmDialogBody'

// Fixed footer — never scrolls away
const CrmDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'shrink-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end px-6 py-4 border-t border-border/50',
      className,
    )}
    {...props}
  />
)
CrmDialogFooter.displayName = 'CrmDialogFooter'

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
}
