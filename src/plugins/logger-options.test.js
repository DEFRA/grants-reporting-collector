const getTraceIdMock = vi.fn()

vi.mock('@defra/hapi-tracing', () => ({
  getTraceId: getTraceIdMock
}))

vi.mock('@elastic/ecs-pino-format', () => ({
  ecsFormat: vi.fn(() => ({
    messageKey: 'message',
    formatters: {
      level: () => ({})
    }
  }))
}))

vi.mock('#/config.js', () => ({
  config: {
    get: vi.fn((key) => {
      switch (key) {
        case 'log':
          return {
            isEnabled: true,
            redact: ['password', 'token'],
            level: 'info',
            format: 'ecs'
          }
        case 'serviceName':
          return 'test-service'
        case 'serviceVersion':
          return '1.2.3'
        default:
          return undefined
      }
    })
  }
}))

describe('loggerOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should build logger options from config', async () => {
    const { loggerOptions } = await import('./logger-options.js')

    expect(loggerOptions.enabled).toBe(true)
    expect(loggerOptions.ignorePaths).toEqual(['/health'])

    expect(loggerOptions.redact).toEqual({
      paths: ['password', 'token'],
      remove: true
    })

    expect(loggerOptions.level).toBe('info')
    expect(loggerOptions.nesting).toBe(true)

    // Properties merged from ecsFormat()
    expect(loggerOptions.messageKey).toBe('message')
    expect(loggerOptions.formatters).toBeDefined()
  })

  it('should return trace id in mixin when available', async () => {
    getTraceIdMock.mockReturnValue('trace-123')

    const { loggerOptions } = await import('./logger-options.js')

    expect(loggerOptions.mixin()).toEqual({
      trace: {
        id: 'trace-123'
      }
    })
  })

  it('should return empty object when trace id is not available', async () => {
    getTraceIdMock.mockReturnValue(undefined)

    const { loggerOptions } = await import('./logger-options.js')

    expect(loggerOptions.mixin()).toEqual({})
  })
})
