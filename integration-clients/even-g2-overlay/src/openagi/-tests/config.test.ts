import { describe, expect, it } from 'vitest'
import { loadOpenAGIConfig } from '../config'

describe('agent configuration', () => {
  it('starts unconfigured for every user', () => {
    expect(loadOpenAGIConfig({})).toEqual({ origin: '', allowedOrigins: [] })
  })
  it.each(['https://user:secret@main.example.com', 'https://main.example.com/path', 'https://main.example.com?token=secret', 'http://localhost.evil.example'])('rejects unsafe or ambiguous main URLs: %s', origin => {
    expect(() => loadOpenAGIConfig({ VITE_AGENT_DEFAULT_ORIGIN: origin })).toThrow()
  })
  it('normalizes and deduplicates the exact origins compiled into the package', () => {
    expect(loadOpenAGIConfig({
      VITE_AGENT_DEFAULT_ORIGIN: 'https://one.example.com/',
      VITE_AGENT_ALLOWED_ORIGINS: 'https://one.example.com,https://two.example.com/',
    })).toEqual({
      origin: 'https://one.example.com',
      allowedOrigins: ['https://one.example.com', 'https://two.example.com'],
    })
  })

  it('rejects non-local cleartext agent URLs', () => {
    expect(() => loadOpenAGIConfig({ VITE_AGENT_DEFAULT_ORIGIN: 'http://agent.example.com' })).toThrow()
  })
})
