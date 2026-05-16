import { Injectable, Logger } from '@nestjs/common'

interface NbuRateResponse {
  r030: number
  txt: string
  rate: number
  cc: string
  exchangedate: string
}

export interface ExchangeRateResult {
  usdUah: string
  usdtUah: string
  eurUah: string
  date: string
}

@Injectable()
export class NbuCurrencyService {
  private readonly logger = new Logger(NbuCurrencyService.name)

  // Fetch NBU rates for a specific date (YYYYMMDD) or today
  async getRates(date?: string): Promise<ExchangeRateResult> {
    const dateStr = date ?? this.todayStr()
    const url = `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${dateStr}&json`

    let rates: NbuRateResponse[]
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`NBU API status ${res.status}`)
      rates = (await res.json()) as NbuRateResponse[]
    } catch (err) {
      this.logger.warn(`NBU API unavailable for ${dateStr}, trying yesterday`)
      // Fallback: try previous day (weekends/holidays have no data)
      const prev = this.prevDayStr(dateStr)
      try {
        const res2 = await fetch(
          `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${prev}&json`,
        )
        if (!res2.ok) throw new Error(`NBU fallback status ${res2.status}`)
        rates = (await res2.json()) as NbuRateResponse[]
      } catch {
        this.logger.error('NBU API completely unavailable, using hardcoded fallback')
        return { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: dateStr }
      }
    }

    const usd = rates.find((r) => r.cc === 'USD')?.rate ?? 41.5
    const eur = rates.find((r) => r.cc === 'EUR')?.rate ?? 44.8

    return {
      usdUah: usd.toFixed(4),
      usdtUah: usd.toFixed(4), // USDT pegged to USD
      eurUah: eur.toFixed(4),
      date: dateStr,
    }
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '')
  }

  private prevDayStr(yyyymmdd: string): string {
    const d = new Date(
      `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`,
    )
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10).replace(/-/g, '')
  }
}
