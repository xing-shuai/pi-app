import { Type } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

const MAX_BYTES = 128 * 1024
const MAX_LOOKUPS = 6
const REQUEST_TIMEOUT_MS = 8000
const ORIGINS = new Set(['https://geocoding-api.open-meteo.com', 'https://api.open-meteo.com'])
const parameters = Type.Object({
  city: Type.String({ minLength: 1, maxLength: 80, description: 'City name, Chinese or English; not a URL' }),
  country: Type.Optional(Type.String({ pattern: '^[A-Za-z]{2}$', description: 'Optional ISO 3166-1 alpha-2 country code, e.g. CN' })),
}, { additionalProperties: false })
const inputSchema = z.object({
  city: z.string().trim().min(1).max(80).refine((s) => !/[\x00-\x1f\x7f/:@\\]/.test(s), 'City name required'),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
}).strict()
const publicText = z.string().trim().min(1).max(120).refine((s) => !/[\x00-\x1f\x7f]/.test(s))
const locationSchema = z.object({
  name: publicText, country: publicText.optional(), admin1: publicText.optional(),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
})
const currentSchema = z.object({
  timezone: z.string().min(1).max(100).regex(/^[A-Za-z0-9_+\-/]+$/),
  utc_offset_seconds: z.number().int().min(-86400).max(86400),
  current: z.object({
    time: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/),
    temperature_2m: z.number().finite().min(-150).max(100),
    apparent_temperature: z.number().finite().min(-200).max(150),
    wind_speed_10m: z.number().finite().min(0).max(500),
    precipitation: z.number().finite().min(0).max(5000),
    weather_code: z.number().int().min(0).max(99),
    is_day: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
})
class WeatherError extends Error {}

/** Only constructed URLs reach fetch. Never accept URLs, credentials or raw coordinates from the model. */
async function publicJson(url: URL, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
  if (!ORIGINS.has(url.origin) || url.protocol !== 'https:' || url.username || url.password) throw new WeatherError('Weather endpoint not allowed.')
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS)
  const requestSignal = AbortSignal.any([signal, timeout.signal])
  try {
    requestSignal.throwIfAborted()
    const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: requestSignal, headers: { Accept: 'application/json' } })
    if (!response.ok) { await response.body?.cancel(); throw new WeatherError('Weather provider is unavailable. No weather data was obtained.') }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel(); throw new WeatherError('Weather response exceeded the size limit.')
    }
    if (!response.body) throw new WeatherError('Weather provider returned no data.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        requestSignal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) throw new WeatherError('Weather response exceeded the size limit.')
        chunks.push(value)
      }
    } finally {
      // Abort/cancel the stream on limits, timeouts and malformed responses; no detached reads.
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    requestSignal.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (signal.aborted) throw new WeatherError('Weather lookup cancelled. No current weather result is available.')
    if (timeout.signal.aborted) throw new WeatherError('Weather lookup timed out. No current weather result is available.')
    if (error instanceof WeatherError) throw error
    // Do not expose response bodies, URLs, fetch exception messages, headers or credentials.
    throw new WeatherError('Weather provider returned unavailable or invalid data. Do not invent weather conditions.')
  } finally { clearTimeout(timer) }
}

/** Run-scoped budget and lifecycle; routine and SDK tool-call aborts both stop the HTTPS request. */
export function createWeatherTool(routineSignal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): { tool: ToolDefinition; dispose: () => void } {
  const lifecycle = new AbortController()
  let lookups = 0
  const tool: ToolDefinition<typeof parameters> = {
    name: 'weather', label: 'Online weather lookup (read-only)',
    description: 'Read current public Open-Meteo weather for a city (Chinese or English). Only fixed geocoding and weather HTTPS endpoints; no shell, files or general web access. Report the provider observation time and timezone, not an unsupported claim of latest/live data. If unavailable, explain without inventing conditions.',
    parameters,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async execute(_id, params, toolSignal) {
      const signal = AbortSignal.any([routineSignal, lifecycle.signal, ...(toolSignal ? [toolSignal] : [])])
      if (signal.aborted) throw new WeatherError('Weather lookup cancelled.')
      if (++lookups > MAX_LOOKUPS) throw new WeatherError('Weather lookup limit reached for this run (6 lookups).')
      const parsed = inputSchema.safeParse(params)
      if (!parsed.success) throw new WeatherError('Use a city name of 1–80 characters and an optional two-letter country code; URLs are not accepted.')
      const { city, country } = parsed.data
      const geo = new URL('https://geocoding-api.open-meteo.com/v1/search')
      geo.search = new URLSearchParams({ name: city, count: '1', language: /[\u3400-\u9fff]/u.test(city) ? 'zh' : 'en', format: 'json', ...(country ? { countryCode: country.toUpperCase() } : {}) }).toString()
      const geocoded = z.object({ results: z.array(locationSchema).max(10).optional() }).safeParse(await publicJson(geo, signal, fetcher))
      if (!geocoded.success) throw new WeatherError('Weather geocoding returned invalid data.')
      const location = geocoded.data.results?.[0]
      if (!location) throw new WeatherError('No matching city was found. Ask for a more specific city or country; do not invent weather.')
      const forecast = new URL('https://api.open-meteo.com/v1/forecast')
      forecast.search = new URLSearchParams({
        latitude: String(location.latitude), longitude: String(location.longitude), timezone: 'auto',
        temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm',
        current: 'temperature_2m,apparent_temperature,wind_speed_10m,precipitation,weather_code,is_day',
      }).toString()
      const result = currentSchema.safeParse(await publicJson(forecast, signal, fetcher))
      if (!result.success) throw new WeatherError('Weather provider returned incomplete or invalid current conditions. Do not invent missing values.')
      const { current: c, timezone, utc_offset_seconds } = result.data
      const text = [
        'Source: Open-Meteo public weather (https://open-meteo.com/); geocoding-api.open-meteo.com and api.open-meteo.com.',
        `Matched location: ${JSON.stringify([location.name, location.admin1, location.country].filter(Boolean).join(', '))} (${location.latitude}, ${location.longitude}).`,
        `Provider observation time: ${c.time}; timezone: ${timezone}; UTC offset: ${utc_offset_seconds} seconds. This is the provider timestamp, not a guarantee of latest/live conditions.`,
        `Temperature: ${c.temperature_2m} °C; apparent temperature: ${c.apparent_temperature} °C; wind: ${c.wind_speed_10m} km/h; precipitation: ${c.precipitation} mm; WMO weather code: ${c.weather_code}.`,
        ...(c.is_day === undefined ? [] : [`Daylight: ${c.is_day === 1 ? 'day' : 'night'}.`]),
      ].join('\n')
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
  return { tool, dispose: () => lifecycle.abort() }
}
