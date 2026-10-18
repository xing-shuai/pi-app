// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { createWeatherTool } from './weather'

export const geoPayload = { results: [{ name: '杭州', admin1: '浙江', country: '中国', latitude: 30.27, longitude: 120.15 }] }
export const weatherPayload = { timezone: 'Asia/Shanghai', utc_offset_seconds: 28800, current: {
  time: '2026-05-01T16:00', temperature_2m: 23.4, apparent_temperature: 24.1,
  wind_speed_10m: 9.2, precipitation: 0.2, weather_code: 3, is_day: 1,
} }
function fixture(fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(geoPayload)).mockImplementationOnce(async () => Response.json(geoPayload)).mockImplementationOnce(async () => Response.json(weatherPayload))) {
  const controller = new AbortController()
  const weather = createWeatherTool(controller.signal, fetcher)
  const call = (params: unknown = { city: '杭州', country: 'CN' }, signal?: AbortSignal) => weather.tool.execute('call', params, signal, undefined, {} as ExtensionToolContext)
  return { ...weather, controller, call, fetcher }
}
afterEach(() => vi.useRealTimers())

describe('fixed-origin read-only public weather', () => {
  it.each(['杭州', 'Hangzhou'])('normalizes %s with timestamps, timezone, source, units and daylight', async (city) => {
    const f = fixture()
    const result = await f.call({ city, country: 'cn' })
    const text = JSON.stringify(result)
    for (const value of ['杭州', '23.4', '24.1', '9.2', '0.2', 'code: 3', '2026-05-01T16:00', 'Asia/Shanghai', 'Open-Meteo', 'Daylight: day', 'not a guarantee of latest']) expect(text).toContain(value)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    const [geo, options] = f.fetcher.mock.calls[0]
    expect(new URL(String(geo)).searchParams.get('name')).toBe(city)
    expect(new URL(String(geo)).searchParams.get('countryCode')).toBe('CN')
    expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', method: 'GET', headers: { Accept: 'application/json' } })
    expect(new URL(String(f.fetcher.mock.calls[1][0])).origin).toBe('https://api.open-meteo.com')
    expect(new URL(String(f.fetcher.mock.calls[1][0])).searchParams.get('latitude')).toBe('30.27')
    expect(result.details).toBeUndefined()
  })
  it('tolerates missing optional daylight without inventing it', async () => {
    const payload = structuredClone(weatherPayload)
    delete (payload.current as Partial<typeof payload.current>).is_day
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(geoPayload)).mockResolvedValueOnce(Response.json(payload)))
    expect(JSON.stringify(await f.call())).not.toContain('Daylight:')
  })
  it.each([{ city: '' }, { city: 'a'.repeat(81) }, { city: 'https://localhost/secret' }, { city: '杭州\nsecret' }, { city: '杭州', country: 'China' }, { city: '杭州', url: 'http://localhost' }])('rejects invalid/URL-like input before fetching: %j', async (params) => {
    const f = fixture()
    await expect(f.call(params)).rejects.toThrow(/city name/)
    expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('uses URLSearchParams and never treats city characters as URL authority or query parameters', async () => {
    const f = fixture()
    await f.call({ city: 'Hangzhou &name=secret?#', country: 'CN' })
    const url = new URL(String(f.fetcher.mock.calls[0][0]))
    expect(url.origin).toBe('https://geocoding-api.open-meteo.com')
    expect(url.searchParams.get('name')).toBe('Hangzhou &name=secret?#')
    expect(url.hash).toBe('')
  })
  it.each([{}, { results: [] }])('reports no geocoding matches and does not request a forecast', async (payload) => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)))
    await expect(f.call()).rejects.toThrow(/No matching city/)
    expect(f.fetcher).toHaveBeenCalledOnce()
  })
  it.each([{ ...geoPayload.results[0], latitude: 91 }, { ...geoPayload.results[0], longitude: -181 }, { ...geoPayload.results[0], name: 'x'.repeat(121) }])('rejects invalid public coordinates/labels without a forecast', async (location) => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ results: [location] })))
    await expect(f.call()).rejects.toThrow(/invalid data/)
    expect(f.fetcher).toHaveBeenCalledOnce()
  })
  it.each([{}, { ...weatherPayload, current: { ...weatherPayload.current, temperature_2m: null } }, { ...weatherPayload, timezone: 'secret\nINJECT' }])('rejects incomplete/malformed current data', async (payload) => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(geoPayload)).mockResolvedValueOnce(Response.json(payload)))
    await expect(f.call()).rejects.toThrow(/invalid current conditions/)
  })
  it.each(['network', 'status', 'redirect', 'json'])('returns safe errors without raw provider secrets (%s)', async (kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      expect(options?.redirect).toBe('error')
      if (kind === 'network' || kind === 'redirect') throw new Error('Authorization: Bearer SECRET https://private.local/')
      return new Response('SECRET', { status: kind === 'status' ? 503 : 200 })
    })
    const f = fixture(fetcher)
    const error = await f.call().catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/SECRET|private\.local|Authorization/)
    expect(String(error)).toMatch(/unavailable|invalid/)
  })
  it.each([false, true])('bounds the streamed response (content length header=%s)', async (header) => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(128 * 1024 + 1), { headers: header ? { 'Content-Length': String(128 * 1024 + 1) } : {} })))
    await expect(f.call()).rejects.toThrow(/size limit/)
  })
  it('caps attempts at 6 lookups / at most 12 HTTP requests per run, including failures', async () => {
    const f = fixture(vi.fn<typeof fetch>().mockImplementation(async (url) => Response.json(new URL(String(url)).hostname.startsWith('geocoding') ? geoPayload : weatherPayload)))
    for (let n = 0; n < 6; n++) await f.call()
    await expect(f.call()).rejects.toThrow(/limit reached/)
    expect(f.fetcher).toHaveBeenCalledTimes(12)
  })
  it.each(['routine', 'tool', 'dispose', 'timeout'] as const)('aborts active fetch on %s and settles before returning', async (reason) => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options!.signal!
      requestSignal.addEventListener('abort', () => reject(new Error('SECRET abort detail')), { once: true })
    }))
    const f = fixture(fetcher), toolController = new AbortController()
    const promise = f.call({ city: 'Hangzhou' }, toolController.signal).catch((e: Error) => e)
    if (reason === 'routine') f.controller.abort()
    if (reason === 'tool') toolController.abort()
    if (reason === 'dispose') f.dispose()
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(8000)
    expect(requestSignal?.aborted).toBe(true)
    expect(String(await promise)).toMatch(reason === 'timeout' ? /timed out/ : /cancelled/)
    expect(String(await promise)).not.toContain('SECRET')
  })
  it('also times out while streaming the body, not only awaiting response headers', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(controller) { options!.signal!.addEventListener('abort', () => controller.error(new Error('SECRET body')), { once: true }) },
    })))
    const f = fixture(fetcher)
    const pending = f.call().catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(8000)
    expect(String(await pending)).toMatch(/timed out/)
    expect(vi.getTimerCount()).toBe(0)
  })
})
