import { Trans, useLingui } from '@lingui/react/macro'
import { Bookmark, Copy } from 'lucide-react'
import { toast } from 'sonner'
import bookmarklet from 'virtual:bookmarklet'
import { Button } from '@/components/ui/button'
import { CrmDialogBody, CrmDialogContent, CrmDialogHeader } from '@/components/ui/crm-dialog'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'

type Browser = 'chromium' | 'firefox' | 'safari'

/** Which bookmark manager the steps describe; Edge, Opera and Brave are Chromium. */
export function browserOf(userAgent: string): Browser {
  if (/Firefox\//.test(userAgent)) return 'firefox'
  if (/Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(userAgent)) return 'safari'
  return 'chromium'
}

/** The bookmarklet bound to this CRM: the build leaves the origin as a placeholder. */
export function bookmarkletFor(origin: string): string {
  return bookmarklet.replaceAll('__CRM_ORIGIN__', encodeURIComponent(origin))
}

interface BookmarkletInstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * How HR installs the "To CRM" bookmarklet. No browser lets a page create a bookmark, so the
 * script is copied (or dragged) into the browser's own bookmark manager by hand.
 */
export function BookmarkletInstallDialog({ open, onOpenChange }: BookmarkletInstallDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <InstallContent />}
    </Dialog>
  )
}

function InstallContent() {
  const { t } = useLingui()
  const script = bookmarkletFor(window.location.origin)
  const browser = browserOf(navigator.userAgent)
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgent)
  const mod = mac ? 'Cmd' : 'Ctrl'
  // Chrome on a Mac opens its bookmark manager with Cmd+Option+B, not Cmd+Shift+O
  const managerKeys = mac ? 'Cmd+Option+B' : 'Ctrl+Shift+O'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(script)
    } catch {
      toast.error(
        t`Не вдалося скопіювати скрипт. Перетягніть посилання «До CRM» на панель закладок.`,
      )
      return
    }
    toast.success(t`Скрипт скопійовано`)
  }

  return (
    <CrmDialogContent maxWidth="sm:max-w-xl" data-testid="bookmarklet-install-dialog">
      <CrmDialogHeader>
        <DialogTitle>
          <Trans>Закладка «До CRM»</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            Один клік на сторінці вакансії — і CRM відкриє форму зовнішньої подачі з полями, які
            вдалося заповнити.
          </Trans>
        </DialogDescription>
      </CrmDialogHeader>
      <CrmDialogBody className="flex flex-col gap-5 pb-5 text-sm">
        <section className="flex flex-col gap-3">
          <h3 className="font-medium">
            <Trans>Як додати</Trans>
          </h3>
          <ol
            data-testid="bookmarklet-steps"
            data-browser={browser}
            className="flex list-decimal flex-col gap-2 pl-5"
          >
            <li>
              <Trans>Скопіюйте скрипт:</Trans>
              <Button
                type="button"
                size="sm"
                className="mt-1 ml-2 min-h-11 sm:min-h-8"
                data-testid="bookmarklet-copy"
                onClick={() => void copy()}
              >
                <Copy aria-hidden="true" className="size-4" />
                <Trans>Скопіювати скрипт</Trans>
              </Button>
            </li>
            {browser === 'chromium' && (
              <li>
                <Trans>
                  Натисніть {managerKeys} — відкриється менеджер закладок. Натисніть «⋮» угорі
                  праворуч → «Додати нову закладку».
                </Trans>
              </li>
            )}
            {browser === 'firefox' && (
              <li>
                <Trans>
                  Натисніть {mod}+Shift+O — відкриється бібліотека закладок. Клацніть правою кнопкою
                  на «Панель закладок» → «Додати закладку…».
                </Trans>
              </li>
            )}
            {browser === 'safari' && (
              <li>
                <Trans>
                  Додайте будь-яку сторінку в закладки (Cmd+D), потім відкрийте «Закладки» →
                  «Редагувати закладки», знайдіть її там, клацніть правою кнопкою й змініть адресу.
                </Trans>
              </li>
            )}
            <li>
              <Trans>
                Назва — «До CRM», а в поле адреси вставте скопійований скрипт. Збережіть.
              </Trans>
            </li>
          </ol>
          <p className="text-muted-foreground">
            <Trans>Або перетягніть «До CRM» на панель закладок:</Trans>
            <a
              // React refuses a javascript: href, so the attribute is set on the element directly.
              ref={(el) => el?.setAttribute('href', script)}
              data-testid="bookmarklet-drag-link"
              draggable
              onClick={(e) => {
                e.preventDefault()
                toast.info(t`Перетягніть «До CRM» на панель закладок, а не клацайте.`)
              }}
              className="ml-2 inline-flex min-h-11 items-center gap-1 rounded-md border px-2 font-medium text-foreground sm:min-h-8"
            >
              <Bookmark aria-hidden="true" className="size-4" />
              <Trans>До CRM</Trans>
            </a>
          </p>
        </section>
        <section className="flex flex-col gap-3" data-testid="bookmarklet-how-it-works">
          <h3 className="font-medium">
            <Trans>Як це працює</Trans>
          </h3>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li>
              <Trans>Відкрийте сторінку вакансії.</Trans>
            </li>
            <li>
              <Trans>
                На незнайомому сайті виділіть текст вакансії — так CRM точно візьме потрібне.
              </Trans>
            </li>
            <li>
              <Trans>
                Натисніть закладку «До CRM». CRM відкриється в новій вкладці; якщо браузер блокує
                спливні вікна, дозвольте їх для сайту вакансії.
              </Trans>
            </li>
            <li>
              <Trans>
                Перевірте поля з позначками «Не розпізнано — заповніть вручну» та «Перевірте це
                значення», виберіть сеньйора й резюме та запишіть подачу.
              </Trans>
            </li>
          </ol>
          <p className="text-muted-foreground" data-testid="bookmarklet-not-recognized">
            <Trans>
              «Вакансію не розпізнано» означає, що скрипт не знайшов вакансію на сторінці. Виділіть
              її текст і натисніть закладку ще раз або вставте його у форму.
            </Trans>
          </p>
        </section>
      </CrmDialogBody>
    </CrmDialogContent>
  )
}
