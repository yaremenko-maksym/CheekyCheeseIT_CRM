import { CheckIcon, ChevronsUpDown } from 'lucide-react'
import * as RPNInput from 'react-phone-number-input'
import flags from 'react-phone-number-input/flags'
import { validatePhoneNumberLength } from 'libphonenumber-js/min'
import React, {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ComponentProps, ElementRef, ForwardRefExoticComponent } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const PhoneInputContext = createContext<{
  defaultCountry: RPNInput.Country
  currentCountry: RPNInput.Country
  inputRef: React.RefObject<HTMLInputElement | null>
}>({ defaultCountry: 'UA', currentCountry: 'UA', inputRef: { current: null } })

export type PhoneInputProps = Omit<ComponentProps<'input'>, 'onChange' | 'value' | 'ref'> &
  Omit<RPNInput.Props<typeof RPNInput.default>, 'onChange' | 'value'> & {
    value?: RPNInput.Value | undefined
    onChange: (value: RPNInput.Value) => void
  }

const PhoneInput: ForwardRefExoticComponent<PhoneInputProps> = forwardRef<
  ElementRef<typeof RPNInput.default>,
  PhoneInputProps
>(({ className, onChange, value, defaultCountry = 'UA', ...props }, ref) => {
  const [currentCountry, setCurrentCountry] = useState<RPNInput.Country>(defaultCountry)
  const inputRef = useRef<HTMLInputElement>(null)
  const suppressNextUndefined = useRef(false)

  // Initialize with calling code on first render when value is empty
  useEffect(() => {
    if (!value) {
      const callingCode = RPNInput.getCountryCallingCode(defaultCountry)
      if (callingCode) onChange(`+${callingCode}` as RPNInput.Value)
    }
  }, [])

  const handleChange = (val: RPNInput.Value) => {
    // RPNInput emits undefined after a country change when there are no local digits to migrate.
    // Suppress it so our calling-code value set in handleCountryChange is not wiped.
    if (!val && suppressNextUndefined.current) {
      suppressNextUndefined.current = false
      return
    }
    if (!val) {
      onChange(val)
      return
    }
    if (val.startsWith('+')) {
      onChange(val)
      return
    }
    try {
      const parsed = RPNInput.parsePhoneNumber(val, currentCountry)
      if (parsed?.isValid()) {
        onChange(parsed.number as RPNInput.Value)
        return
      }
    } catch {
      /* unparseable — pass through raw */
    }
    onChange(val)
  }

  const handleCountryChange = (country: RPNInput.Country | undefined) => {
    if (!country) return
    setCurrentCountry(country)
    const callingCode = RPNInput.getCountryCallingCode(country)
    if (callingCode) {
      suppressNextUndefined.current = true
      onChange(`+${callingCode}` as RPNInput.Value)
    }
  }

  return (
    <PhoneInputContext.Provider value={{ defaultCountry, currentCountry, inputRef }}>
      <RPNInput.default
        {...props}
        ref={ref}
        className={cn('flex', className)}
        flagComponent={FlagComponent}
        value={value ?? ''}
        countrySelectComponent={CountrySelectWrapper}
        inputComponent={PhoneTextInput}
        smartCaret={false}
        onChange={handleChange}
        defaultCountry={defaultCountry}
        onCountryChange={handleCountryChange}
      />
    </PhoneInputContext.Provider>
  )
})
PhoneInput.displayName = 'PhoneInput'

// Module-level stable components — never remounted on parent re-render

const PhoneTextInput = forwardRef<HTMLInputElement, ComponentProps<'input'>>(
  ({ className, ...props }, ref) => {
    const { currentCountry, inputRef } = useContext(PhoneInputContext)

    const setRefs = (el: HTMLInputElement | null) => {
      ;(inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el
    }

    const checkIfValidInput = (value: string) => {
      const initialValueTestString = `${value}0`
      const initialValueTestResult = validatePhoneNumberLength(initialValueTestString)

      if (initialValueTestResult === 'TOO_LONG') return false

      if (initialValueTestResult === 'INVALID_COUNTRY' && currentCountry) {
        const withoutPlus = `+${initialValueTestString}`

        let isCurrentCountry = false
        try {
          isCurrentCountry = RPNInput.parsePhoneNumber(withoutPlus)?.country === currentCountry
        } catch {
          // unparseable number — treat as not matching current country
        }

        if (isCurrentCountry) {
          return validatePhoneNumberLength(withoutPlus) !== 'TOO_LONG'
        }

        const withoutCountryCode = `+${RPNInput.getCountryCallingCode(currentCountry)}${initialValueTestString}`
        if (validatePhoneNumberLength(withoutCountryCode) === 'TOO_LONG') return false
      }

      return true
    }

    return (
      <Input
        {...props}
        ref={setRefs}
        className={cn('rounded-s-none rounded-e-md border-l-0', className)}
        placeholder="Номер телефона"
        onChange={(e) => {
          if (checkIfValidInput(e.target.value)) {
            props.onChange?.(e)
          }
        }}
      />
    )
  },
)
PhoneTextInput.displayName = 'PhoneTextInput'

type CountrySelectProps = {
  disabled?: boolean
  value: RPNInput.Country
  options: Array<{ value: RPNInput.Country; label: string }>
  onChange: (country: RPNInput.Country) => void
  onCountryChange?: (country: RPNInput.Country) => void
}

const CountrySelectWrapper = (props: CountrySelectProps) => {
  const { defaultCountry } = useContext(PhoneInputContext)
  return <CountrySelect {...props} value={props.value ?? defaultCountry} />
}

const CountrySelect = ({
  disabled,
  value: selectedCountry,
  options,
  onChange,
  onCountryChange,
}: CountrySelectProps) => {
  const { inputRef } = useContext(PhoneInputContext)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const [searchValue, setSearchValue] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  // Synchronous filtering — useDeferredValue introduced non-deterministic
  // commit timing which caused flaky CI test (sets country calling code in input
  // after switching country via dropdown). Filtering 200 entries is cheap.
  const countryList = useMemo(
    () =>
      options.filter(
        (opt) => Boolean(opt.value) && opt.label.toLowerCase().includes(searchValue.toLowerCase()),
      ),
    [options, searchValue],
  )

  return (
    <Popover
      open={isOpen}
      modal
      onOpenChange={(open) => {
        setIsOpen(open)
        if (open) {
          setSearchValue('')
        } else {
          // Popover restores focus to trigger on close — override with input focus
          setTimeout(() => {
            inputRef.current?.focus()
          }, 0)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="flex h-9 gap-1 rounded-e-none rounded-s-md border-r-0 px-3 focus:z-10"
          disabled={disabled}
        >
          <FlagComponent country={selectedCountry} countryName={selectedCountry} />
          <ChevronsUpDown className={cn('h-3 w-3 opacity-50', disabled && 'hidden')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput
            value={searchValue}
            onValueChange={setSearchValue}
            placeholder="Поиск страны..."
          />
          <CommandList>
            <CommandEmpty>Страна не найдена</CommandEmpty>
            <CommandGroup>
              <ScrollArea ref={scrollAreaRef} className="h-52">
                {countryList.map(({ value, label }) => (
                  <CommandItem
                    key={value}
                    className="gap-2 cursor-pointer"
                    onSelect={() => {
                      onChange(value)
                      onCountryChange?.(value)
                      setIsOpen(false)
                    }}
                  >
                    <FlagComponent country={value} countryName={label} />
                    <span className="flex-1 text-sm">{label}</span>
                    <span className="text-xs text-muted-foreground">
                      +{RPNInput.getCountryCallingCode(value)}
                    </span>
                    <CheckIcon
                      className={cn(
                        'ml-auto h-4 w-4',
                        value === selectedCountry ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                ))}
              </ScrollArea>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const FlagComponent = ({ country, countryName }: RPNInput.FlagProps) => {
  const Flag = flags[country]
  return (
    <span className="flex h-4 w-6 overflow-hidden rounded-sm bg-muted [&_svg:not([class*='size-'])]:size-full">
      {Flag && <Flag title={countryName} />}
    </span>
  )
}

export { PhoneInput }
